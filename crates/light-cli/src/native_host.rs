//! Chrome native messaging host: lets the extension's Node page start, stop
//! and watch a node on this Mac.
//!
//! Chrome starts this program for each message (`chrome.runtime.
//! sendNativeMessage`), passing one message on stdin: a 4-byte native-endian
//! length, then JSON. It answers the same way on stdout and exits. Nodes are
//! started detached, in their own process group, so they keep running after
//! this process exits; their process ids are kept in the data folder.
//!
//! Two nodes, one at a time:
//! - `light`: `neptune-light peer-node` (this same program), Neptune peers
//!   only, no RPC server, nothing stored but a log;
//! - `full`: `neptune-core`, the official archival node.
//!
//! Both serve the wallet on 127.0.0.1:9797.
//!
//! Setup, once: `neptune-light install-host --extension-id ID` writes the
//! host manifest for Chrome (and Brave / Chromium if present).

use std::fs;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};

pub const HOST_NAME: &str = "com.escanour.node";
const RPC_PORT: u16 = 9797;

fn data_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME is not set")?;
    let dir = Path::new(&home).join("Library/Application Support/Escanour");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn pid_file(kind: &str) -> Result<PathBuf> {
    Ok(data_dir()?.join(format!("{kind}-node.pid")))
}

fn log_file(kind: &str) -> Result<PathBuf> {
    Ok(data_dir()?.join(format!("{kind}-node.log")))
}

fn running(kind: &str) -> Option<u32> {
    let pid: u32 = fs::read_to_string(pid_file(kind).ok()?).ok()?.trim().parse().ok()?;
    // `kill -0` checks that the process exists without touching it.
    let alive = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    alive.then_some(pid)
}

fn tail(path: &Path, lines: usize) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return vec![];
    };
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..]
        .iter()
        .map(|s| s.chars().take(300).collect())
        .collect()
}

/// neptune-core: a path the user gave, or the usual install places.
fn find_neptune_core(given: Option<&str>) -> Result<PathBuf> {
    if let Some(p) = given.filter(|s| !s.is_empty()) {
        let p = match p.strip_prefix("~/") {
            Some(rest) => Path::new(&std::env::var("HOME").unwrap_or_default()).join(rest),
            None => PathBuf::from(p),
        };
        ensure!(p.is_file(), "{} does not exist", p.display());
        return Ok(p);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.cargo/bin/neptune-core"),
        "/opt/homebrew/bin/neptune-core".into(),
        "/usr/local/bin/neptune-core".into(),
        format!("{home}/bin/neptune-core"),
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .ok_or_else(|| {
            anyhow!("neptune-core was not found. Install it (github.com/Neptune-Crypto/neptune-core releases) or give its path.")
        })
}

fn start(msg: &Value) -> Result<Value> {
    let kind = msg["kind"].as_str().unwrap_or("light");
    ensure!(kind == "light" || kind == "full", "kind is light or full");
    for k in ["light", "full"] {
        if let Some(pid) = running(k) {
            if k == kind {
                return Ok(json!({ "started": false, "pid": pid, "note": "already running" }));
            }
            bail!("the {k} node is running; stop it first (both use port {RPC_PORT})");
        }
    }
    let network = msg["network"].as_str().unwrap_or("main");
    ensure!(
        ["main", "testnet", "testnet-mock"].contains(&network),
        "unknown network {network}"
    );
    let log = fs::File::create(log_file(kind)?)?;
    let mut cmd = if kind == "light" {
        let exe = std::env::current_exe()?;
        let mut c = Command::new(exe);
        c.args(["--network", network, "peer-node", "--listen", &format!("127.0.0.1:{RPC_PORT}")]);
        for p in msg["peers"].as_array().into_iter().flatten().filter_map(Value::as_str).take(16) {
            ensure!(
                p.chars().all(|c| c.is_ascii_alphanumeric() || ".:-[]".contains(c)),
                "invalid peer address {p}"
            );
            c.args(["--peer", p]);
        }
        c
    } else {
        let mut c = Command::new(find_neptune_core(msg["path"].as_str())?);
        c.args([
            "--network",
            network,
            // The JSON-RPC the wallet reads (--rpc-port is the CLI's tarpc port).
            &format!("--listen-rpc=127.0.0.1:{RPC_PORT}"),
            "--rpc-modules",
            "Node,Chain,Wallet,Utxoindex",
            "--utxo-index",
        ]);
        c
    };
    let child = cmd
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        // Its own process group: Chrome ends this host, not the node.
        .process_group(0)
        .spawn()
        .with_context(|| format!("could not start the {kind} node"))?;
    fs::write(pid_file(kind)?, child.id().to_string())?;
    Ok(json!({ "started": true, "pid": child.id(), "rpc": format!("http://127.0.0.1:{RPC_PORT}/") }))
}

fn stop(msg: &Value) -> Result<Value> {
    let kind = msg["kind"].as_str().unwrap_or("light");
    let Some(pid) = running(kind) else {
        let _ = fs::remove_file(pid_file(kind)?);
        return Ok(json!({ "stopped": false, "note": "not running" }));
    };
    Command::new("kill").args(["-TERM", &pid.to_string()]).status()?;
    let _ = fs::remove_file(pid_file(kind)?);
    Ok(json!({ "stopped": true, "pid": pid }))
}

fn status() -> Result<Value> {
    let one = |kind: &str| -> Result<Value> {
        Ok(json!({
            "running": running(kind).is_some(),
            "pid": running(kind),
            "log": tail(&log_file(kind)?, 15),
        }))
    };
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "rpc": format!("http://127.0.0.1:{RPC_PORT}/"),
        "light": one("light")?,
        "full": one("full")?,
        "neptuneCore": find_neptune_core(None).ok().map(|p| p.display().to_string()),
    }))
}

fn answer(msg: &Value) -> Value {
    let r = match msg["cmd"].as_str().unwrap_or("") {
        "status" => status(),
        "start" => start(msg),
        "stop" => stop(msg),
        other => Err(anyhow!("unknown command {other}")),
    };
    match r {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
}

/// One message in, one answer out (Chrome's framing).
pub fn serve_once() -> Result<()> {
    let mut stdin = std::io::stdin();
    let mut len = [0u8; 4];
    stdin.read_exact(&mut len)?;
    let len = u32::from_ne_bytes(len) as usize;
    ensure!(len <= 1024 * 1024, "message too large");
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf)?;
    let msg: Value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
    let out = serde_json::to_vec(&answer(&msg))?;
    let mut stdout = std::io::stdout();
    stdout.write_all(&(out.len() as u32).to_ne_bytes())?;
    stdout.write_all(&out)?;
    stdout.flush()?;
    Ok(())
}

/// Register the host with Chrome, Brave and Chromium for this user.
pub fn install(extension_id: &str) -> Result<()> {
    ensure!(
        extension_id.len() == 32 && extension_id.chars().all(|c| ('a'..='p').contains(&c)),
        "the extension id is 32 letters a-p (chrome://extensions, Developer mode)"
    );
    let home = std::env::var("HOME").context("HOME is not set")?;
    let exe = std::env::current_exe()?.canonicalize()?;
    // Chrome passes the caller's origin as an argument; a wrapper turns that
    // into the native-host command.
    let wrapper = data_dir()?.join("escanour-node-host");
    fs::write(
        &wrapper,
        format!("#!/bin/sh\nexec \"{}\" native-host \"$@\"\n", exe.display()),
    )?;
    Command::new("chmod").args(["755", &wrapper.display().to_string()]).status()?;
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Escanour Neptune Wallet: start and stop a node on this Mac",
        "path": wrapper,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")],
    });
    let mut written = vec![];
    for browser in [
        "Google/Chrome",
        "Google/Chrome Beta",
        "BraveSoftware/Brave-Browser",
        "Chromium",
    ] {
        let base = Path::new(&home).join("Library/Application Support").join(browser);
        if !base.is_dir() {
            continue;
        }
        let dir = base.join("NativeMessagingHosts");
        fs::create_dir_all(&dir)?;
        let file = dir.join(format!("{HOST_NAME}.json"));
        fs::write(&file, serde_json::to_string_pretty(&manifest)?)?;
        written.push(file.display().to_string());
    }
    ensure!(!written.is_empty(), "no Chrome, Brave or Chromium profile folder was found");
    for w in written {
        println!("registered: {w}");
    }
    println!("Reload the extension, then open its Node page.");
    Ok(())
}
