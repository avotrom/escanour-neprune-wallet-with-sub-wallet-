// Portions adapted from neptune-core, Copyright Triton Software AG and
// contributors, Apache License 2.0. Modified by avotrom. See NOTICE.

//! Splitting a ProofCollection into independent proof jobs, and assembling
//! the results.
//!
//! A ProofCollection is four fixed subproofs plus one per lock script and one
//! per type script. Each depends only on its own (program, claim,
//! nondeterminism), so the jobs can run in separate Web Workers, each with its
//! own wasm instance and its own 4 GB address space. The claims built here
//! follow neptune-consensus `ProofCollection::produce`.

use anyhow::{ensure, Result};
use itertools::Itertools;
use neptune_consensus::consensus_rule_set::{ConsensusRuleSet, TritonProofVersion};
use neptune_consensus::proof_abstractions::SecretWitness;
use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
use neptune_consensus::transaction::transaction_kernel::TransactionKernelField;
use neptune_consensus::transaction::validity::collect_lock_scripts::CollectLockScriptsWitness;
use neptune_consensus::transaction::validity::collect_type_scripts::CollectTypeScriptsWitness;
use neptune_consensus::transaction::validity::kernel_to_outputs::KernelToOutputsWitness;
use neptune_consensus::transaction::validity::neptune_proof::Proof as NeptuneProof;
use neptune_consensus::transaction::validity::proof_collection::ProofCollection;
use neptune_consensus::transaction::validity::removal_records_integrity::RemovalRecordsIntegrityWitness;
use neptune_primitives::mast_hash::MastHash;
use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
use neptune_wallet::triton_vm::prelude::{BFieldElement, Program};
use neptune_wallet::triton_vm::proof::{Claim, Proof as VmProof};
use neptune_wallet::triton_vm::stark::Stark;
use neptune_wallet::triton_vm::vm::NonDeterminism;
use serde::{Deserialize, Serialize};

/// One unit of proving work, self-contained so a worker needs nothing else.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProofJob {
    pub label: String,
    pub program: Program,
    pub claim: Claim,
    pub non_determinism: NonDeterminism,
}

impl ProofJob {
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        Ok(bincode::serialize(self)?)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(bincode::deserialize(bytes)?)
    }
}

/// The claim version nodes expect for a rule set. Mirrors the crate-private
/// `TritonProofVersion::version` in neptune-consensus.
pub fn claim_version(rule_set: ConsensusRuleSet) -> u32 {
    match rule_set.triton_proof_version() {
        TritonProofVersion::V0 => 0,
        TritonProofVersion::V1 => 1,
        TritonProofVersion::V5 => 5,
        TritonProofVersion::V8 => 8,
    }
}

/// Whether the bundled Triton VM can produce proofs for this rule set.
pub fn can_prove_for(rule_set: ConsensusRuleSet) -> bool {
    claim_version(rule_set) == neptune_wallet::triton_vm::proof::CURRENT_VERSION
}

fn job(label: &str, program: Program, claim: Claim, nd: NonDeterminism) -> ProofJob {
    ProofJob {
        label: label.to_string(),
        program,
        claim,
        non_determinism: nd,
    }
}

fn reversed_values(d: Digest) -> Vec<BFieldElement> {
    d.reversed().values().to_vec()
}

/// All jobs for a ProofCollection, in assembly order:
/// removal-records-integrity, collect-lock-scripts, kernel-to-outputs,
/// collect-type-scripts, then each lock script, then each type script.
/// The first job is usually the largest; schedule it first.
pub fn proof_collection_jobs(pw: &PrimitiveWitness, version: u32) -> Vec<ProofJob> {
    let rri = RemovalRecordsIntegrityWitness::from(pw);
    let cls = CollectLockScriptsWitness::from(pw);
    let k2o = KernelToOutputsWitness::from(pw);
    let cts = CollectTypeScriptsWitness::from(pw);

    let txk = pw.kernel.mast_hash();
    let salted_inputs = Tip5::hash(&pw.input_utxos);
    let salted_outputs = Tip5::hash(&pw.output_utxos);

    let mut jobs = vec![
        job(
            "removal-records-integrity",
            rri.program(),
            rri.claim().about_version(version),
            rri.nondeterminism(),
        ),
        job(
            "collect-lock-scripts",
            cls.program(),
            cls.claim().about_version(version),
            cls.nondeterminism(),
        ),
        job(
            "kernel-to-outputs",
            k2o.program(),
            k2o.claim().about_version(version),
            k2o.nondeterminism(),
        ),
        job(
            "collect-type-scripts",
            cts.program(),
            cts.claim().about_version(version),
            cts.nondeterminism(),
        ),
    ];

    for (i, lsaw) in pw.lock_scripts_and_witnesses.iter().enumerate() {
        let claim = Claim::new(lsaw.program.hash())
            .about_version(version)
            .with_input(reversed_values(txk));
        jobs.push(job(
            &format!("lock-script-{i}"),
            lsaw.program.clone(),
            claim,
            lsaw.nondeterminism(),
        ));
    }

    let ts_input: Vec<BFieldElement> = [txk, salted_inputs, salted_outputs]
        .into_iter()
        .flat_map(reversed_values)
        .collect();
    for (i, tsaw) in pw.type_scripts_and_witnesses.iter().enumerate() {
        let claim = Claim::new(tsaw.program.hash())
            .about_version(version)
            .with_input(ts_input.clone());
        jobs.push(job(
            &format!("type-script-{i}"),
            tsaw.program.clone(),
            claim,
            tsaw.nondeterminism(),
        ));
    }

    jobs
}

/// How much memory proving may use. Triton VM can keep the low-degree
/// extended trace (the trace stretched over the FRI/quotient domain) in memory
/// for speed, or recompute the parts it needs. Recomputing is slower and the
/// proof is the same: the choice changes performance only (triton-vm
/// `config` module).
///
/// Triton VM decides this itself only on Linux and Android, where it can read
/// free memory. In wasm it cannot, and it simply tries to keep the whole copy,
/// which can exhaust a worker's 4 GB. So the wallet decides here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LowMemory {
    /// Keep the copy only for jobs whose copy stays under [`AUTO_LIMIT_BYTES`].
    Auto,
    /// Never keep the copy: least memory, slowest.
    On,
    /// Keep the copy whenever it fits in one wasm instance
    /// ([`FIT_LIMIT_BYTES`]): fastest, most memory.
    Off,
}

impl LowMemory {
    pub fn parse(s: &str) -> Self {
        match s {
            "on" => Self::On,
            "off" => Self::Off,
            _ => Self::Auto,
        }
    }
}

/// Automatic mode keeps the copy up to 1 GiB, so a worker stays well inside
/// its 4 GB and several workers fit in a laptop's memory.
pub const AUTO_LIMIT_BYTES: u64 = 1 << 30;
/// Above about 2.5 GiB the copy cannot fit next to everything else proving
/// needs in one 4 GB wasm instance.
pub const FIT_LIMIT_BYTES: u64 = 5 << 29;

/// What happened while proving one job, for the proof report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProveReport {
    pub label: String,
    /// Height of the execution trace, padded to a power of two.
    pub padded_height: u64,
    /// Size the low-degree extended trace would take if kept in memory.
    pub lde_cache_bytes: u64,
    /// True when that copy was not kept (low-memory proving).
    pub low_memory: bool,
    pub proof_bytes: u64,
}

/// Bytes of the low-degree extended trace for a padded height: rows of the
/// larger of the FRI and quotient domains, times the width of the main
/// (base field, 8 bytes) and auxiliary (extension field, 24 bytes) tables.
/// Same computation as triton-vm's `Prover::lde_trace_cache_decision`.
pub fn lde_cache_bytes(stark: &Stark, padded_height: usize) -> Result<u64> {
    use neptune_wallet::triton_vm::table::master_table::{MasterAuxTable, MasterMainTable};
    let fri_rows = stark.fri(padded_height)?.domain.len();
    let max_degree = usize::try_from(stark.max_degree(padded_height)).unwrap_or(0);
    let quotient_rows = max_degree.next_power_of_two();
    let rows = fri_rows.max(quotient_rows) as u64;
    let row_bytes = (MasterMainTable::NUM_COLUMNS * 8 + MasterAuxTable::NUM_COLUMNS * 24) as u64;
    Ok(rows.saturating_mul(row_bytes))
}

/// Run one job with the given memory policy, and say what it did.
pub fn prove_with(job: &ProofJob, mode: LowMemory) -> Result<(VmProof, ProveReport)> {
    use neptune_wallet::triton_vm::config::{overwrite_lde_trace_caching_to, CacheDecision};
    use neptune_wallet::triton_vm::vm::VM;

    ensure!(
        job.program.hash() == job.claim.program_digest,
        "{}: program does not match its claim",
        job.label
    );
    let (aet, output) = VM::trace_execution(
        job.program.clone(),
        (&job.claim.input).into(),
        job.non_determinism.clone(),
    )?;
    ensure!(
        output == job.claim.output,
        "{}: program output does not match its claim",
        job.label
    );

    let stark = Stark::default();
    let padded_height = aet.padded_height();
    let cache_bytes = lde_cache_bytes(&stark, padded_height)?;
    let low_memory = match mode {
        LowMemory::On => true,
        LowMemory::Auto => cache_bytes > AUTO_LIMIT_BYTES,
        LowMemory::Off => cache_bytes > FIT_LIMIT_BYTES,
    };
    // Thread-local in Triton VM; set for every job, since a worker proves
    // several jobs in a row.
    overwrite_lde_trace_caching_to(if low_memory {
        CacheDecision::NoCache
    } else {
        CacheDecision::Cache
    });

    let proof = stark.prove(&job.claim, &aet)?;
    let report = ProveReport {
        label: job.label.clone(),
        padded_height: padded_height as u64,
        lde_cache_bytes: cache_bytes,
        low_memory,
        proof_bytes: (proof.0.len() * 8) as u64,
    };
    Ok((proof, report))
}

/// Run one job with the automatic memory policy. Used by the CLI.
pub fn prove(job: &ProofJob) -> Result<VmProof> {
    Ok(prove_with(job, LowMemory::Auto)?.0)
}

/// Put the proofs (in job order) back together into a ProofCollection.
pub fn assemble(pw: &PrimitiveWitness, proofs: Vec<VmProof>) -> Result<ProofCollection> {
    let n_lock = pw.lock_scripts_and_witnesses.len();
    let n_type = pw.type_scripts_and_witnesses.len();
    ensure!(
        proofs.len() == 4 + n_lock + n_type,
        "expected {} proofs, got {}",
        4 + n_lock + n_type,
        proofs.len()
    );

    let mut it = proofs.into_iter().map(NeptuneProof::from);
    let mut next = || it.next().expect("length checked above");
    let removal_records_integrity = next();
    let collect_lock_scripts = next();
    let kernel_to_outputs = next();
    let collect_type_scripts = next();
    let lock_scripts_halt = (0..n_lock).map(|_| next()).collect_vec();
    let type_scripts_halt = (0..n_type).map(|_| next()).collect_vec();

    Ok(ProofCollection {
        removal_records_integrity,
        collect_lock_scripts,
        lock_scripts_halt,
        kernel_to_outputs,
        collect_type_scripts,
        type_scripts_halt,
        lock_script_hashes: pw
            .lock_scripts_and_witnesses
            .iter()
            .map(|l| l.program.hash())
            .collect(),
        type_script_hashes: pw
            .type_scripts_and_witnesses
            .iter()
            .map(|t| t.program.hash())
            .collect(),
        kernel_mast_hash: pw.kernel.mast_hash(),
        salted_inputs_hash: Tip5::hash(&pw.input_utxos),
        salted_outputs_hash: Tip5::hash(&pw.output_utxos),
        merge_bit_mast_path: pw.kernel.mast_path(TransactionKernelField::MergeBit),
    })
}
