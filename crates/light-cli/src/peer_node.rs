//! Light node: Neptune's peer network in, the wallet's RPC out.
//!
//! The browser cannot open TCP connections, so this small program does it
//! for the wallet. It talks only to Neptune nodes, over their own peer
//! protocol (the legacy TCP stack, port 9798, which v0.20.1 nodes still
//! accept), and never to an RPC server. It serves the handful of JSON-RPC
//! methods the wallet reads on 127.0.0.1, so the wallet uses it exactly like
//! "My own node".
//!
//! It stores no chain. Blocks are fetched from peers on demand and kept in a
//! small cache. It checks nothing either: since soft fork epsilon (block
//! 62,500 on main net) the wallet's Full node mode verifies the tip's
//! recursive proof, so a lying peer is caught there, and the wallet's own
//! sync checks that every block extends the previous one.
//!
//! Wire format, as neptune-core's `PeerFrameCodec`: a big-endian u32 length,
//! then one `PeerMessage` in bincode (default options: varint integers).

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, anyhow, bail, ensure};
use bincode::Options;
use light_core::neptune_consensus::block::Block;
use light_core::neptune_consensus::transaction::Transaction;
use light_core::neptune_primitives::block_height::BlockHeight;
use light_core::neptune_primitives::difficulty_control::ProofOfWork;
use light_core::neptune_primitives::network::Network;
use light_core::neptune_rpc_api::model::block::RpcBlock;
use light_core::neptune_rpc_api::model::message::{
    GetBlocksRequest, GetBlocksResponse, HeightResponse, NetworkResponse, SubmitTransactionRequest,
    SubmitTransactionResponse, TipResponse,
};
use light_core::neptune_rpc_api::model::wallet::block::RpcWalletBlock;
use neptune_p2p::peer::handshake_data::{HandshakeData, VersionString};
use neptune_p2p::peer::transfer_transaction::TransferTransaction;
use neptune_p2p::peer::{PeerMessage, TransferConnectionStatus};
use serde_json::{Value, json};

const MAGIC_REQUEST: &[u8; 15] = b"7B8AB7FC438F411";
const MAGIC_RESPONSE: &[u8; 15] = b"Hello Neptune!\n";
/// The version this node announces: the one whose protocol it speaks.
const VERSION: &str = "0.20.1";
const MAX_FRAME: usize = 300 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(60);
/// Blocks kept in memory: enough for a wallet catching up in batches.
const CACHE_BLOCKS: usize = 256;
const MAX_PEERS: usize = 4;

fn bincode_opts() -> impl Options + Copy {
    bincode::DefaultOptions::new().with_limit(MAX_FRAME as u64)
}

// --------------------------------------------------------------- one peer --

struct Peer {
    addr: SocketAddr,
    stream: TcpStream,
    tip_height: u64,
    tip_work: ProofOfWork,
}

impl Peer {
    fn send(&mut self, msg: &PeerMessage) -> Result<()> {
        let bytes = bincode_opts().serialize(msg)?;
        ensure!(bytes.len() <= MAX_FRAME, "message too large");
        self.stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
        self.stream.write_all(&bytes)?;
        self.stream.flush()?;
        Ok(())
    }

    fn recv(&mut self) -> Result<PeerMessage> {
        let mut len = [0u8; 4];
        self.stream.read_exact(&mut len)?;
        let len = u32::from_be_bytes(len) as usize;
        ensure!(len <= MAX_FRAME, "peer sent a {len}-byte frame");
        let mut buf = vec![0u8; len];
        self.stream.read_exact(&mut buf)?;
        Ok(bincode_opts().deserialize(&buf)?)
    }

    /// Connect and complete Neptune's handshake as an incoming peer would
    /// see it. We announce the genesis block as our tip (we hold no chain),
    /// no listening port, not archival, and no transaction relay.
    fn connect(addr: SocketAddr, network: Network) -> Result<Self> {
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(10))?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        stream.set_nodelay(true)?;
        let genesis = Block::genesis(network);
        let ours = HandshakeData {
            tip_header: *genesis.header(),
            listen_port: None,
            network,
            instance_id: rand_u128(),
            version: VersionString::new_from_str(VERSION),
            is_archival_node: false,
            is_bootstrapper_node: false,
            timestamp: SystemTime::now(),
            extra_data: HandshakeData::extra_data(false, None),
        };
        let mut p = Peer {
            addr,
            stream,
            tip_height: 0,
            tip_work: <ProofOfWork as num_traits::Zero>::zero(),
        };
        p.send(&PeerMessage::Handshake {
            magic_value: *MAGIC_REQUEST,
            data: Box::new(ours),
        })?;
        let theirs = match p.recv()? {
            PeerMessage::Handshake { magic_value, data } => {
                ensure!(&magic_value == MAGIC_RESPONSE, "{addr} is not a Neptune node");
                data
            }
            other => bail!("{addr} answered {} instead of a handshake", kind(&other)),
        };
        HandshakeData::validate(&ours, &theirs)
            .map_err(|e| anyhow!("{addr}: incompatible peer: {e}"))?;
        match p.recv()? {
            PeerMessage::ConnectionStatus(TransferConnectionStatus::Accepted) => {}
            PeerMessage::ConnectionStatus(TransferConnectionStatus::Refused(r)) => {
                bail!("{addr} refused the connection: {r:?}")
            }
            other => bail!("{addr} sent {} instead of a connection status", kind(&other)),
        }
        p.tip_height = theirs.tip_header.height.into();
        p.tip_work = theirs.tip_header.cumulative_proof_of_work;
        Ok(p)
    }

    /// Wait for the reply matching `want`, answering or noting whatever else
    /// the peer sends in between.
    fn wait_for<T>(
        &mut self,
        state: &Shared,
        mut want: impl FnMut(&PeerMessage) -> Option<T>,
    ) -> Result<T> {
        let deadline = Instant::now() + IO_TIMEOUT;
        loop {
            ensure!(Instant::now() < deadline, "{} did not answer", self.addr);
            let msg = self.recv()?;
            if let Some(t) = want(&msg) {
                return Ok(t);
            }
            self.handle_unsolicited(state, msg)?;
        }
    }

    fn handle_unsolicited(&mut self, state: &Shared, msg: PeerMessage) -> Result<()> {
        match msg {
            PeerMessage::BlockNotification(n) => {
                self.tip_height = n.height.into();
                self.tip_work = n.cumulative_proof_of_work;
                state.lock().unwrap().note_tip(self.tip_height, self.tip_work);
            }
            PeerMessage::PeerListRequest => {
                // We share nothing about other peers.
                self.send(&PeerMessage::PeerListResponse(vec![]))?;
            }
            PeerMessage::PeerListResponse(list) => {
                let mut s = state.lock().unwrap();
                for (addr, _) in list.into_iter().take(64) {
                    s.learn(addr);
                }
            }
            PeerMessage::Bye => bail!("{} said goodbye", self.addr),
            // Notifications, proposals and transactions are not for us.
            _ => {}
        }
        Ok(())
    }

    fn block(&mut self, state: &Shared, height: u64) -> Result<Block> {
        ensure!(height > 0, "the genesis block is built locally, never fetched");
        self.send(&PeerMessage::BlockRequestByHeight(BlockHeight::from(height)))?;
        let tb = self.wait_for(state, |m| match m {
            PeerMessage::Block(b) if u64::from(b.header.height) == height => Some((**b).clone()),
            _ => None,
        })?;
        Block::try_from(tb).map_err(|e| anyhow!("{} sent a malformed block: {e}", self.addr))
    }
}

fn kind(m: &PeerMessage) -> String {
    let s = format!("{m:?}");
    s.split(['(', ' ', '{']).next().unwrap_or("?").to_string()
}

fn rand_u128() -> u128 {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("system randomness");
    u128::from_le_bytes(b)
}

// ------------------------------------------------------------ shared state --

struct State {
    network: Network,
    known: VecDeque<SocketAddr>,
    seen: HashSet<SocketAddr>,
    best_height: u64,
    best_work: ProofOfWork,
    cache: BTreeMap<u64, Block>,
    log: VecDeque<String>,
}

type Shared = Arc<Mutex<State>>;

impl State {
    fn learn(&mut self, addr: SocketAddr) {
        if self.seen.insert(addr) {
            self.known.push_back(addr);
        }
    }
    fn note_tip(&mut self, height: u64, work: ProofOfWork) {
        if work > self.best_work {
            self.best_work = work;
            self.best_height = height;
            // Blocks at or above a new tip may belong to a losing fork.
            self.cache.retain(|&h, _| h < height);
        }
    }
    fn say(&mut self, line: String) {
        eprintln!("{line}");
        self.log.push_back(line);
        while self.log.len() > 50 {
            self.log.pop_front();
        }
    }
}

/// The connected peers, each behind its own lock so requests to different
/// peers run side by side.
struct Pool {
    state: Shared,
    peers: Mutex<Vec<Arc<Mutex<Peer>>>>,
}

impl Pool {
    fn connected(&self) -> usize {
        self.peers.lock().unwrap().len()
    }

    /// Fill up to MAX_PEERS from the known addresses, and ask the new ones
    /// for more addresses and their tips.
    fn top_up(&self) {
        while self.connected() < MAX_PEERS {
            let (addr, network) = {
                let mut s = self.state.lock().unwrap();
                match s.known.pop_front() {
                    Some(a) => (a, s.network),
                    None => return,
                }
            };
            if self.peers.lock().unwrap().iter().any(|p| p.lock().unwrap().addr == addr) {
                continue;
            }
            match Peer::connect(addr, network) {
                Ok(mut p) => {
                    let _ = p.send(&PeerMessage::PeerListRequest);
                    let mut s = self.state.lock().unwrap();
                    s.note_tip(p.tip_height, p.tip_work);
                    s.say(format!("connected to {addr}, its tip is block {}", p.tip_height));
                    // Keep the address for the next round too.
                    s.known.push_back(addr);
                    drop(s);
                    self.peers.lock().unwrap().push(Arc::new(Mutex::new(p)));
                }
                Err(e) => {
                    let mut s = self.state.lock().unwrap();
                    s.say(format!("{addr}: {e:#}"));
                    s.known.push_back(addr);
                }
            }
        }
    }

    fn drop_peer(&self, addr: SocketAddr, why: &anyhow::Error) {
        self.peers.lock().unwrap().retain(|p| p.try_lock().map(|p| p.addr != addr).unwrap_or(true));
        self.state.lock().unwrap().say(format!("dropped {addr}: {why:#}"));
    }

    /// The peers that claim the best tip, first.
    fn ranked(&self) -> Vec<Arc<Mutex<Peer>>> {
        let mut v: Vec<_> = self.peers.lock().unwrap().clone();
        v.sort_by_key(|p| std::cmp::Reverse(p.lock().map(|p| p.tip_height).unwrap_or(0)));
        v
    }

    fn block(&self, height: u64) -> Result<Block> {
        if let Some(b) = self.state.lock().unwrap().cache.get(&height) {
            return Ok(b.clone());
        }
        let mut last = anyhow!("no Neptune peer is connected");
        for peer in self.ranked() {
            let mut p = peer.lock().unwrap();
            if p.tip_height < height {
                continue;
            }
            let addr = p.addr;
            match p.block(&self.state, height) {
                Ok(b) => {
                    drop(p);
                    let mut s = self.state.lock().unwrap();
                    s.cache.insert(height, b.clone());
                    while s.cache.len() > CACHE_BLOCKS {
                        let first = *s.cache.keys().next().unwrap();
                        s.cache.remove(&first);
                    }
                    return Ok(b);
                }
                Err(e) => {
                    drop(p);
                    self.drop_peer(addr, &e);
                    last = e;
                }
            }
        }
        Err(last)
    }

    /// Ask every peer for its tip; read what arrives.
    fn refresh_tips(&self) {
        for peer in self.ranked() {
            let Ok(mut p) = peer.try_lock() else { continue };
            let addr = p.addr;
            let r = p.send(&PeerMessage::BlockNotificationRequest).and_then(|_| {
                p.wait_for(&self.state, |m| match m {
                    PeerMessage::BlockNotification(n) => Some(n.clone()),
                    _ => None,
                })
            });
            match r {
                Ok(n) => {
                    p.tip_height = n.height.into();
                    p.tip_work = n.cumulative_proof_of_work;
                    let (h, w) = (p.tip_height, p.tip_work);
                    drop(p);
                    self.state.lock().unwrap().note_tip(h, w);
                }
                Err(e) => {
                    drop(p);
                    self.drop_peer(addr, &e);
                }
            }
        }
    }

    fn broadcast(&self, tx: &TransferTransaction) -> usize {
        let mut sent = 0;
        for peer in self.ranked() {
            let mut p = peer.lock().unwrap();
            if p.send(&PeerMessage::Transaction(Box::new(tx.clone()))).is_ok() {
                sent += 1;
            }
        }
        sent
    }
}

// ----------------------------------------------------------------- the RPC --

fn rpc_result(pool: &Pool, method: &str, params: &Value) -> Result<Value> {
    let network = pool.state.lock().unwrap().network;
    match method {
        "chain_height" => {
            ensure!(pool.connected() > 0, "not connected to any Neptune peer yet");
            let h = pool.state.lock().unwrap().best_height;
            Ok(serde_json::to_value(HeightResponse {
                height: BlockHeight::from(h),
            })?)
        }
        "node_network" => Ok(serde_json::to_value(NetworkResponse {
            network: network.to_string(),
        })?),
        "wallet_getBlocks" => {
            let req: GetBlocksRequest = parse_params(params)?;
            let (from, to): (u64, u64) = (req.from_height.into(), req.to_height.into());
            ensure!(from >= 1 && to >= from, "bad range {from}..={to}");
            ensure!(to - from < 100, "at most 100 blocks per call");
            let mut blocks = Vec::new();
            for h in from..=to {
                blocks.push(RpcWalletBlock::from(&pool.block(h)?));
            }
            Ok(serde_json::to_value(GetBlocksResponse { blocks })?)
        }
        "chain_tip" => {
            ensure!(pool.connected() > 0, "not connected to any Neptune peer yet");
            let h = pool.state.lock().unwrap().best_height;
            ensure!(h > 0, "the peers are at the genesis block");
            let b = pool.block(h)?;
            Ok(serde_json::to_value(TipResponse {
                block: RpcBlock::from(&b),
            })?)
        }
        "wallet_submitTransaction" => {
            let req: SubmitTransactionRequest = parse_params(params)?;
            let tx = Transaction::from(req.transaction);
            let transfer = TransferTransaction::try_from(&tx)?;
            let sent = pool.broadcast(&transfer);
            ensure!(sent > 0, "no Neptune peer took the transaction");
            pool.state.lock().unwrap().say(format!("transaction sent to {sent} peer(s)"));
            Ok(serde_json::to_value(SubmitTransactionResponse { success: true })?)
        }
        // Status for the extension's Node page.
        "lightnode_status" => {
            let s = pool.state.lock().unwrap();
            Ok(json!({
                "network": network.to_string(),
                "peers": pool.connected(),
                "known": s.known.len(),
                "height": s.best_height,
                "cached": s.cache.len(),
                "log": s.log.iter().rev().take(12).collect::<Vec<_>>(),
            }))
        }
        "lightnode_addPeer" => {
            let addr = params
                .get(0)
                .or_else(|| params.get("addr"))
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("give a peer address, host:port"))?;
            for a in resolve(addr)? {
                pool.state.lock().unwrap().learn(a);
            }
            Ok(json!(true))
        }
        other => bail!("method {other} is not served by the light node"),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T> {
    // jsonrpsee accepts named (object) or positional (array) parameters.
    match params {
        Value::Array(a) if a.len() == 1 && a[0].is_object() => {
            Ok(serde_json::from_value(a[0].clone())?)
        }
        _ => Ok(serde_json::from_value(params.clone())?),
    }
}

fn resolve(s: &str) -> Result<Vec<SocketAddr>> {
    let with_port = if s.contains(':') && !s.starts_with('[') || s.ends_with(']') {
        if s.rsplit(':').next().is_some_and(|p| p.parse::<u16>().is_ok()) {
            s.to_string()
        } else {
            format!("{s}:9798")
        }
    } else {
        format!("{s}:9798")
    };
    Ok(with_port
        .to_socket_addrs()
        .with_context(|| format!("cannot resolve {s}"))?
        .collect())
}

fn handle_http(pool: &Pool, stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let method = line.split_whitespace().next().unwrap_or("").to_string();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    ensure!(len <= 64 * 1024 * 1024, "request too large");
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    let reply = if method == "OPTIONS" {
        String::new()
    } else {
        let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let m = req.get("method").and_then(Value::as_str).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(Value::Array(vec![]));
        match rpc_result(pool, m, &params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": format!("{e:#}") } })
                .to_string(),
        }
    };
    let mut out = stream;
    write!(
        out,
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\naccess-control-allow-origin: *\r\naccess-control-allow-headers: content-type\r\naccess-control-allow-methods: POST, OPTIONS\r\nconnection: close\r\n\r\n{reply}",
        reply.len()
    )?;
    Ok(())
}

// ------------------------------------------------------------------- main --

pub fn run(network: Network, listen: &str, peers: &[String]) -> Result<()> {
    let listen: SocketAddr = listen.parse().context("--listen must be ip:port")?;
    ensure!(
        listen.ip().is_loopback(),
        "the light node only serves this computer: listen on 127.0.0.1"
    );
    let state: Shared = Arc::new(Mutex::new(State {
        network,
        known: VecDeque::new(),
        seen: HashSet::new(),
        best_height: 0,
        best_work: <ProofOfWork as num_traits::Zero>::zero(),
        cache: BTreeMap::new(),
        log: VecDeque::new(),
    }));
    for p in peers {
        match resolve(p) {
            Ok(addrs) => addrs.into_iter().for_each(|a| state.lock().unwrap().learn(a)),
            Err(e) => eprintln!("{e:#}"),
        }
    }
    if state.lock().unwrap().known.is_empty() {
        eprintln!("No peer address yet. Add one with --peer HOST[:9798] (or from the Node page).");
    }
    let pool = Arc::new(Pool {
        state: state.clone(),
        peers: Mutex::new(vec![]),
    });

    // Peers: keep connected, keep the tip fresh.
    {
        let pool = pool.clone();
        thread::spawn(move || loop {
            pool.top_up();
            pool.refresh_tips();
            thread::sleep(Duration::from_secs(20));
        });
    }

    let listener = TcpListener::bind(listen)?;
    eprintln!("Light node for {network} serving the wallet on http://{listen}/");
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        // Only this computer.
        if !stream.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false) {
            continue;
        }
        let pool = pool.clone();
        thread::spawn(move || {
            if let Err(e) = handle_http(&pool, stream) {
                eprintln!("request: {e:#}");
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_as_neptune_core_writes_them() {
        let msg = PeerMessage::BlockRequestByHeight(BlockHeight::from(62_500u64));
        let bytes = bincode_opts().serialize(&msg).unwrap();
        let back: PeerMessage = bincode_opts().deserialize(&bytes).unwrap();
        assert_eq!(format!("{msg:?}"), format!("{back:?}"));
        // Variant index first, as the frame codec peeks it.
        assert!(!bytes.is_empty());
    }

    #[test]
    fn peer_addresses_default_to_the_legacy_port() {
        assert_eq!(resolve("127.0.0.1").unwrap()[0].port(), 9798);
        assert_eq!(resolve("127.0.0.1:1234").unwrap()[0].port(), 1234);
    }

    #[test]
    fn our_handshake_passes_neptunes_own_validation() {
        let network = Network::Main;
        let h = |id| HandshakeData {
            tip_header: *Block::genesis(network).header(),
            listen_port: None,
            network,
            instance_id: id,
            version: VersionString::new_from_str(VERSION),
            is_archival_node: false,
            is_bootstrapper_node: false,
            timestamp: SystemTime::now(),
            extra_data: HandshakeData::extra_data(false, None),
        };
        assert!(HandshakeData::validate(&h(1), &h(2)).is_ok());
    }
}
