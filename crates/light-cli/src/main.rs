//! `neptune-light`: native harness for light-core.
//!
//! Runs exactly the logic the browser extension runs, natively, so it can be
//! tested and benchmarked without a browser. The state file is NOT encrypted:
//! use it on testnet or with small amounts only.
//!
//! The seed phrase is read from the NEPTUNE_PHRASE environment variable so it
//! does not end up in shell history.
//!
//! Examples:
//!   neptune-light new-phrase
//!   NEPTUNE_PHRASE="..." neptune-light --server https://host init
//!   NEPTUNE_PHRASE="..." neptune-light --server https://host sync
//!   NEPTUNE_PHRASE="..." neptune-light balance
//!   NEPTUNE_PHRASE="..." neptune-light address
//!   NEPTUNE_PHRASE="..." neptune-light --server https://host send <address> <amount> <fee> [--workers 4]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use light_core::keys::Keys;
use light_core::send::{self, PreparedSend, SendRequest};
use light_core::state::WalletState;
use light_core::{jobs, parse_network, rpc, sync};
use rayon::prelude::*;

const DEFAULT_SERVER: &str = "https://wallet.neptunefundamentals.org";

struct Args {
    server: String,
    network: String,
    state_path: PathBuf,
    workers: usize,
    birthday: Option<u64>,
    rest: Vec<String>,
}

fn parse_args() -> Result<Args> {
    let mut server = DEFAULT_SERVER.to_string();
    let mut network = "main".to_string();
    let mut state_path = PathBuf::from("neptune-light-state.bin");
    let mut workers = 2usize;
    let mut birthday = None;
    let mut rest = vec![];
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--server" => server = it.next().context("--server needs a value")?,
            "--network" => network = it.next().context("--network needs a value")?,
            "--state" => state_path = it.next().context("--state needs a value")?.into(),
            "--workers" => workers = it.next().context("--workers needs a value")?.parse()?,
            "--birthday" => {
                birthday = Some(it.next().context("--birthday needs a value")?.parse()?)
            }
            _ => rest.push(a),
        }
    }
    Ok(Args {
        server,
        network,
        state_path,
        workers,
        birthday,
        rest,
    })
}

struct Rpc {
    url: String,
    next_id: u64,
}

impl Rpc {
    fn post(&mut self, body: String) -> Result<String> {
        self.next_id += 1;
        let resp = ureq::post(&self.url)
            .set("content-type", "application/json")
            .send_string(&body);
        match resp {
            Ok(r) => Ok(r.into_string()?),
            Err(ureq::Error::Status(code, r)) => {
                bail!("HTTP {code}: {}", r.into_string().unwrap_or_default())
            }
            Err(e) => Err(e.into()),
        }
    }

    fn height(&mut self) -> Result<u64> {
        let body = rpc::request_body(self.next_id, rpc::METHOD_HEIGHT, rpc::height_params());
        rpc::parse_height(&self.post(body)?)
    }

    fn blocks_body(&mut self, from: u64, to: u64) -> Result<String> {
        let params = rpc::get_blocks_params(from, to)?;
        let body = rpc::request_body(self.next_id, rpc::METHOD_GET_BLOCKS, params);
        self.post(body)
    }
}

fn keys(args: &Args) -> Result<Keys> {
    let phrase = std::env::var("NEPTUNE_PHRASE")
        .map_err(|_| anyhow!("set NEPTUNE_PHRASE to your 18-word seed phrase"))?;
    Keys::from_phrase(&phrase, parse_network(&args.network)?)
}

fn load(args: &Args) -> Result<WalletState> {
    let bytes = std::fs::read(&args.state_path).with_context(|| {
        format!(
            "no state at {}; run `init` first",
            args.state_path.display()
        )
    })?;
    WalletState::from_bytes(&bytes)
}

fn save(args: &Args, st: &WalletState) -> Result<()> {
    std::fs::write(&args.state_path, st.to_bytes()?)?;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let cmd = args.rest.first().cloned().unwrap_or_else(|| "help".into());
    let mut node = Rpc {
        url: args.server.clone(),
        next_id: 1,
    };

    match cmd.as_str() {
        "new-phrase" => {
            let mut bytes = [0u8; 24];
            getrandom_fill(&mut bytes)?;
            println!("{}", Keys::phrase_from_entropy(&bytes)?);
            eprintln!("Write these 18 words down offline. Anyone with them controls the funds.");
        }
        "init" => {
            let k = keys(&args)?;
            let start = match args.birthday {
                Some(h) => h.max(1),
                None => node.height()?,
            };
            let body = node.blocks_body(start, start)?;
            let block = rpc::parse_blocks(&body)?
                .pop()
                .ok_or_else(|| anyhow!("server returned no block at {start}"))?;
            let st = sync::state_from_block(block, k.network())?;
            save(&args, &st)?;
            println!("Wallet starts after block {start}. Run `sync` next.");
        }
        "sync" => {
            let k = keys(&args)?;
            let mut st = load(&args)?;
            // Recent states for rolling back on reorg.
            let mut history: VecDeque<WalletState> = VecDeque::new();
            let t0 = Instant::now();
            let mut applied_total = 0usize;
            loop {
                let tip = node.height()?;
                if st.height >= tip {
                    break;
                }
                let to = (st.height + rpc::MAX_BLOCKS_PER_CALL).min(tip);
                let body = node.blocks_body(st.height + 1, to)?;
                let blocks = rpc::parse_blocks(&body)?;
                if blocks.is_empty() {
                    bail!("server returned no blocks for {}..={to}", st.height + 1);
                }
                history.push_back(st.clone());
                if history.len() > 20 {
                    history.pop_front();
                }
                let r = sync::apply_blocks(&mut st, &k, blocks)?;
                applied_total += r.applied;
                for ev in &r.events {
                    for u in &ev.received {
                        println!(
                            "block {}: received {} (aocl {})",
                            ev.height, u.amount, u.aocl_index
                        );
                    }
                    for u in &ev.spent {
                        println!(
                            "block {}: spent {} (aocl {})",
                            ev.height, u.amount, u.aocl_index
                        );
                    }
                }
                if r.reorg {
                    // `history` ends with the state from before this batch.
                    let before_batch = history.pop_back().expect("pushed above");
                    st = if r.applied > 0 {
                        // The chain changed mid-request: redo this batch.
                        before_batch
                    } else {
                        // Our tip itself was orphaned: go one batch further back.
                        history.pop_back().ok_or_else(|| {
                            anyhow!(
                                "reorg deeper than saved history; re-init from an earlier birthday"
                            )
                        })?
                    };
                    println!("reorg detected; rolled back to {}", st.height);
                }
                save(&args, &st)?;
                eprint!("\rsynced to {} / {tip}", st.height);
            }
            let secs = t0.elapsed().as_secs_f64();
            eprintln!(
                "\ndone: {applied_total} blocks in {secs:.1}s ({:.1} blocks/s)",
                applied_total as f64 / secs.max(0.001)
            );
        }
        "balance" => {
            let st = load(&args)?;
            let b =
                st.balance(light_core::neptune_primitives::timestamp::Timestamp::millis(now_ms()));
            println!("height:      {}", st.height);
            println!("available:   {}", b.available);
            println!("time-locked: {}", b.timelocked);
            println!("in flight:   {}", b.pending_out);
            println!(
                "utxos:       {} unspent",
                st.utxos.iter().filter(|u| u.is_unspent()).count()
            );
        }
        "private-address" => {
            println!("{}", light_core::private_notification::AppAddress::for_keys(&keys(&args)?)?);
        }
        "address" => {
            let k = keys(&args)?;
            let mut st = load(&args)?;
            let i = st.take_receiving_index();
            save(&args, &st)?;
            println!("{}", k.receiving_address_string(i)?);
        }
        "release" => {
            let mut st = load(&args)?;
            let n = st.release_stale_reservations(0);
            save(&args, &st)?;
            println!("released {n} reserved UTXOs");
        }
        "send" => {
            let to = args
                .rest
                .get(1)
                .context("send <address> <amount> <fee>")?
                .clone();
            let amount = args
                .rest
                .get(2)
                .context("send <address> <amount> <fee>")?
                .clone();
            let fee = args
                .rest
                .get(3)
                .context("send <address> <amount> <fee>")?
                .clone();
            let k = keys(&args)?;
            let mut st = load(&args)?;
            let mut pinned = None;
            for attempt in 1..=3 {
                let req = SendRequest {
                    to: &to,
                    amount: send::parse_amount(&amount)?,
                    fee: send::parse_amount(&fee)?,
                    now_ms: now_ms(),
                    pinned_inputs: pinned.clone(),
                    accept_lustration: std::env::var("NEPTUNE_ACCEPT_LUSTRATION").is_ok(),
                    from_kind: None,
                    private_message: None,
                };
                let prepared = send::prepare_send(&st, &k, req)?;
                pinned = Some(prepared.input_aocl_indices.clone());
                let proofs = prove_parallel(&prepared, args.workers)?;
                let tx = send::finish(&prepared, proofs)?;
                let body = rpc::request_body(
                    node.next_id,
                    rpc::METHOD_SUBMIT_TRANSACTION,
                    rpc::submit_params(tx)?,
                );
                match node.post(body).and_then(|b| rpc::parse_submit(&b)) {
                    Ok(true) => {
                        send::record_broadcast(&mut st, &prepared);
                        save(&args, &st)?;
                        println!("broadcast: tx {}", prepared.tx_id());
                        return Ok(());
                    }
                    Ok(false) => bail!("node rejected the transaction"),
                    Err(e) if rpc::is_not_confirmable(&e.to_string()) && attempt < 3 => {
                        eprintln!(
                            "tip moved while proving; syncing and rebuilding (attempt {})",
                            attempt + 1
                        );
                        // Catch up, then rebuild with the same inputs.
                        let tip = node.height()?;
                        while st.height < tip {
                            let to_h = (st.height + rpc::MAX_BLOCKS_PER_CALL).min(tip);
                            let body = node.blocks_body(st.height + 1, to_h)?;
                            let r = sync::apply_blocks(&mut st, &k, rpc::parse_blocks(&body)?)?;
                            if r.reorg {
                                bail!("reorg during send; run `sync` and retry");
                            }
                        }
                        save(&args, &st)?;
                    }
                    Err(e) => return Err(e),
                }
            }
            bail!("gave up after 3 attempts");
        }
        _ => {
            println!(
                "neptune-light [--server URL] [--network main|testnet|testnet-mock] [--state FILE]"
            );
            println!("  new-phrase                         print a new 18-word seed phrase");
            println!(
                "  init [--birthday HEIGHT]           start at the tip, or at HEIGHT to restore"
            );
            println!("  sync                               catch up with the server");
            println!("  balance                            show balance");
            println!("  address                            print a fresh receiving address");
            println!("  private-address                    permanent experimental test-network app address");
            println!(
                "  send ADDRESS AMOUNT FEE [--workers N]  build, prove in parallel, broadcast"
            );
            println!("  release                            free inputs of transactions that never confirmed");
        }
    }
    Ok(())
}

/// Prove all jobs on a thread pool, largest (first) job first, printing a
/// timing line per job: this is the benchmark for the browser's worker count.
fn prove_parallel(
    prepared: &PreparedSend,
    workers: usize,
) -> Result<Vec<light_core::triton_vm::proof::Proof>> {
    let all = prepared.jobs();
    if all.is_empty() {
        return Ok(vec![]);
    }
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(workers.max(1))
        .build()?;
    let t0 = Instant::now();
    let results: Vec<Result<light_core::triton_vm::proof::Proof>> = pool.install(|| {
        all.par_iter()
            .map(|job| {
                let t = Instant::now();
                let p = jobs::prove(job);
                eprintln!("  {:<28} {:>7.1}s", job.label, t.elapsed().as_secs_f64());
                p
            })
            .collect()
    });
    eprintln!(
        "  all {} proofs: {:.1}s with {workers} workers",
        all.len(),
        t0.elapsed().as_secs_f64()
    );
    results.into_iter().collect()
}

fn getrandom_fill(buf: &mut [u8]) -> Result<()> {
    use std::io::Read;
    // Unix: the kernel CSPRNG. On other platforms, swap in the getrandom crate.
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .context("could not read /dev/urandom")
}
