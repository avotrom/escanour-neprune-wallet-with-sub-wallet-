import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../extension/lib/watch-model.js';
import { normalizeServer } from '../extension/lib/rpc.js';
import * as walletModes from '../extension/lib/wallet-modes.js';
import * as privateModel from '../extension/lib/private-notifications.js';
import { encryptRecoveryFile } from '../extension/lib/recovery-file.js';

async function harness() {
  const enc=new TextEncoder(), dec=new TextDecoder();
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const stores={kv:'kv',snapshots:'snapshots',sends:'sends',jobs:'jobs',proofs:'proofs'};
  const maps=Object.fromEntries(Object.values(stores).map(n=>[n,new Map()]));
  const db={STORES:stores,wipeExcept:async()=>{for(const map of Object.values(maps))map.clear();},get:async(s,k)=>maps[s].get(k),put:async(s,k,v)=>maps[s].set(k,v),del:async(s,k)=>maps[s].delete(k),keys:async s=>[...maps[s].keys()],delPrefix:async(s,p)=>{for(const k of maps[s].keys())if(k.startsWith(p))maps[s].delete(k);}};
  const vault={create:async()=>key,sessionKey:async()=>key,exportRawKey:async()=>new Uint8Array(32),phrase:async()=>'',
    encrypt:async(k,data)=>{const iv=crypto.getRandomValues(new Uint8Array(12));return{iv,data:new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},k,data))}},
    decrypt:async(k,b)=>new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:b.iv},k,b.data))};
  const encode=o=>enc.encode(JSON.stringify(o)),decode=b=>JSON.parse(dec.decode(b));
  class Wallet {
    genesisState(){return encode({height:0,watch:[],coins:[]});}
    stateFromBlock(body){return encode({height:JSON.parse(body).to,watch:[],coins:[]});}
    expectedList(bytes){const st=decode(bytes);return (st.expected||[]).filter(c=>!st.profile||c.profile===st.profile);}
    claimDecode(bytes,text,profile){if(text!==profile)throw Error('This payment belongs to another sub-wallet');const st=decode(bytes);return {profile,amount:'1',key_kind:'generation',addition_record:profile,status:(st.expected||[]).some(c=>c.addition_record===profile)?'waiting':'new'};}
    claimRegister(bytes,text,profile){const claim=this.claimDecode(bytes,text,profile),st=decode(bytes);if(claim.status==='new')st.expected=[...(st.expected||[]),{profile,addition_record:profile,amount:'1'}];return {state:encode(st),claim};}
    claimRemove(bytes,record){const st=decode(bytes);return encode({...st,expected:st.expected.filter(c=>c.addition_record!==record)});}
    viewingKeys(bytes,profile){return {profile,index:decode(bytes).receiveIndex||0};}
    mergeRecoveredProfile(oldBytes,newBytes,profile){const old=decode(oldBytes),next=decode(newBytes);return encode({...next,coins:[...(next.coins||[]),...(old.coins||[]).filter(c=>c.profile!==profile)]});}
    carryOver(oldBytes,newBytes){const old=decode(oldBytes),next=decode(newBytes);const expected=[...(next.expected||[])];for(const e of old.expected||[])if(!(next.coins||[]).some(c=>(c.addition_record||c.id)===(e.addition_record||e.id))&&!expected.some(c=>(c.addition_record||c.id)===(e.addition_record||e.id)))expected.push(e);return encode({...next,watch:old.watch,expected});}
    rescanState(oldBytes,newBytes){const old=decode(oldBytes),next=decode(this.carryOver(oldBytes,newBytes));return encode({...next,expected:[...next.expected,...(old.coins||[])]});}
    profileReceiveAddress(bytes,profile,kind){const st=decode(bytes);const index=profile==='refresh'?st.receiveIndex||0:0;return {index,profile,kind,address:profile==='encrypted'?`nescan:${kind}:${index}`:`${profile}:${kind}:${index}`};}
    profileAddressAt(profile,kind,index){return `${profile}:${kind}:${index}`;}
    profileAddressHistory(bytes,profile,kind,offset){const index=decode(bytes).receiveIndex||0;return {profile,kind,rows:offset?[]:[{index,address:this.profileAddressAt(profile,kind,index),current:true,receipts:0}],total:1,next:1};}
    profileState(bytes,profile){return encode({...decode(bytes),profile});}
    summary(bytes){const st=decode(bytes);return {available:st.balances?.[st.profile]||'0',utxos:(st.coins||[]).filter(u=>!st.profile||u.profile===st.profile),by_kind:{generation:'0',ec_hybrid:'0'}};}
    addressAt(kind,index){return `${kind}:${index}`;}
    receiveAddress(bytes,kind){const st=decode(bytes);return {index:st.receiveIndex||0,address:this.addressAt(kind,st.receiveIndex||0),kind};}
    privateAppAddress(){return 'nescan:0';}
    privateReceiveAddress(bytes){const st=decode(bytes);return {index:st.privateIndex||0,address:`nescan:${st.privateIndex||0}`,kind:'private-app'};}
    watchList(bytes){return decode(bytes).watch.map(a=>({id:a.id,label:a.label,kind:a.viewingKey.startsWith('nech')?'ec-hybrid':'generation',from_height:a.fromHeight,scanned_to:a.scanned_to??a.fromHeight-1,coins:[],received:'0',unspent:null}));}
    watchRegistry(bytes){return decode(bytes).watch.map(({id,label,viewingKey,spendKey,fromHeight})=>({id,label,viewingKey,spendKey,fromHeight}));}
    watchReconcile(bytes,json){const state=decode(bytes),regs=JSON.parse(json);if(new Set(regs.map(r=>r.viewingKey)).size!==regs.length)throw Error('this address is already watched');state.watch=regs.map(r=>({...state.watch.find(a=>a.id===r.id&&a.viewingKey===r.viewingKey),...r}));return encode(state);}
    watchCatchUpFor(bytes,body,ids){const state=decode(bytes),range=JSON.parse(body),selected=JSON.parse(ids);for(const a of state.watch)if(selected.includes(a.id))a.scanned_to=range.to;return {state:encode(state),result:{received:0}};}
    free(){}
  }
  const light={maxBlocksPerCall:()=>2,getBlocksRequest:(id,from,to)=>JSON.stringify({from,to}),LightWallet:Wallet,addressInfo:(a)=>({valid:/^(nolga|nech)/.test(a),kind:a.startsWith('nech')?'ec-hybrid':'generation'})};
  const settings={network:'main',createdWallets:{standard:true,refresh:false,encrypted:false},servers:Object.fromEntries(['main','testnet','testnet-mock'].map(n=>[n,{sync:'https://example.invalid/',broadcast:'https://example.invalid/'}])),exactPrivacy:false};
  const settingsStore={NETWORKS:['main','testnet','testnet-mock'],load:async()=>settings,save:async patch=>Object.assign(settings,patch,patch.recoveryModes?{recoveryModes:{...settings.recoveryModes,...patch.recoveryModes}}:{}),serversFor:(s,n=s.network)=>s.servers[n]};
  const session={};const listener={addListener:()=>{}};
  const chrome={runtime:{sendMessage:async()=>{},getURL:x=>x,getContexts:async()=>[],getPlatformInfo:async()=>{},onMessage:listener,onInstalled:listener,onStartup:listener},notifications:{onClicked:listener},storage:{session:{clear:async()=>{for(const k of Object.keys(session))delete session[k];},get:async k=>({[k]:session[k]}),set:async patch=>Object.assign(session,patch)}},alarms:{create:()=>{},onAlarm:listener},sidePanel:{setPanelBehavior:async()=>{}}};
  const rpc={interrupt:()=>{},id:()=>1,post:async(url,body)=>body,normalizeServer};
  rpc.read=(...args)=>rpc.post(...args);rpc.nodeSession=async(s,network=s.network)=>({url:s.servers[network]?.sync||'',label:'A',enabled:false});rpc.resetNodeSession=async()=>{};
  const source=fs.readFileSync(new URL('../extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'')+'\nglobalThis.api = {commands, latestSnapshot, saveSnapshot, dropWallet, setStatus, status, requireWallet, watchCatchUp, watchFastStep, saveSend, getSend, recordBlockEvents, readActivity, runFastRestore, configureRecoveryNode, setTorState, handleSubmitted, resumeSends, expireOldSends, exclusive, plus, runSend, performSync, recoveryStatuses};';
  const context=vm.createContext({chrome,db,vault,light,rpc,settingsStore,...model,...privateModel,...walletModes,encryptRecoveryFile,initLight:async()=>{},t:x=>x,setLanguage:()=>{},TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,crypto,URL,AbortController,AbortSignal,Date,console,setTimeout:(fn,ms)=>{if(ms===0)queueMicrotask(fn);return 1;},clearTimeout:()=>{},setInterval:()=>1,clearInterval:()=>{}});
  new vm.Script(source).runInContext(context);
  const initial=encode({height:100,watch:[]});await context.api.saveSnapshot(key,100,initial,'main');
  return {api:context.api,maps,key,initial,rpc,light,vault,settings,chrome};
}

test('backend enforces private address opt-in and mainnet exclusion before any send',async()=>{
  const h=await harness();
  h.light.addressInfo=()=>({valid:true,kind:'private-app'});
  h.settings.privateNotifications=true;
  await assert.rejects(h.api.commands.receive({kind:'private-app'}),/mainnet/);
  await assert.rejects(h.api.commands.send({to:'nescan1test'}),/mainnet/);
  await assert.rejects(h.api.commands.saveSettings({privateNotifications:true}),/mainnet/);
  h.settings.network='testnet';h.settings.privateNotifications=false;
  await assert.rejects(h.api.commands.receive({kind:'private-app'}),/Enable Encrypted/);
  await assert.rejects(h.api.commands.send({to:'nescan1test'}),/Enable Encrypted/);
  h.settings.privateNotifications=true;
  await h.api.saveSnapshot(h.key,100,h.initial,'testnet');h.api.dropWallet();
  h.settings.createdWallets.encrypted=true;h.settings.activeMode='encrypted';
  assert.equal((await h.api.commands.receive({kind:'generation'})).address,'nescan:generation:0');
  assert.equal((await h.api.commands.receive({kind:'ec-hybrid'})).address,'nescan:ec-hybrid:0');
});

test('only Standard exists by default; explicit creation enables separate two-address sub-wallets',async()=>{
  const h=await harness();
  await assert.rejects(h.api.commands.selectMode({mode:'refresh'}),/Create/);
  await assert.rejects(h.api.commands.createSubwallet({mode:'encrypted'}),/mainnet/);
  h.settings.network='testnet';
  const bytes=new TextEncoder().encode(JSON.stringify({height:100,watch:[],receiveIndex:3}));
  await h.api.saveSnapshot(h.key,100,bytes,'testnet');h.api.dropWallet();
  for(const kind of ['generation','ec-hybrid']) assert.equal((await h.api.commands.receive({kind})).address,`standard:${kind}:0`);
  await h.api.commands.createSubwallet({mode:'refresh'});
  for(const kind of ['generation','ec-hybrid'])assert.equal((await h.api.commands.receive({kind})).address,`refresh:${kind}:3`);
  await assert.rejects(h.api.commands.createSubwallet({mode:'refresh'}),/already exists/);
  await h.api.commands.createSubwallet({mode:'encrypted'});
  for(const kind of ['generation','ec-hybrid'])assert.equal((await h.api.commands.receive({kind})).address,`nescan:${kind}:0`);
  await h.api.commands.selectMode({mode:'standard'});
  assert.equal((await h.api.commands.receive()).address,'standard:generation:0');
});

test('Auto-refresh address history and previous QR addresses stay scoped and bounded',async()=>{
  const h=await harness();h.settings.network='testnet';
  await h.api.saveSnapshot(h.key,100,new TextEncoder().encode(JSON.stringify({height:100,watch:[],receiveIndex:3})),'testnet');
  await h.api.commands.createSubwallet({mode:'refresh'});
  const history=await h.api.commands.addressHistory({kind:'ec-hybrid'});assert.equal(history.profile,'refresh');assert.equal(history.kind,'ec-hybrid');
  const previous=await h.api.commands.receive({kind:'generation',index:1});assert.equal(previous.address,'refresh:generation:1');assert.equal(previous.current,false);
  const current=await h.api.commands.receive({kind:'generation',index:3});assert.equal(current.current,true);
  await assert.rejects(h.api.commands.receive({kind:'generation',index:4}),/Unknown previous/);
  await assert.rejects(h.api.commands.addressHistory({kind:'generation',offset:-1}),/Invalid/);
  await assert.rejects(h.api.commands.addressHistory({kind:'unknown'}),/Unknown/);
  await h.api.commands.selectMode({mode:'standard'});
  await assert.rejects(h.api.commands.receive({kind:'generation',index:0}),/Unknown previous/);
});

test('activity stays with the owning sub-wallet',async()=>{
  const h=await harness();
  await h.api.recordBlockEvents(h.key,[{height:101,timestamp_ms:Date.now(),received:[
    {aocl_index:1,amount:'2',address_kind:'generation',wallet_mode:'standard'},
    {aocl_index:2,amount:'3',address_kind:'ec-hybrid',wallet_mode:'refresh'},
    {aocl_index:3,amount:'4',address_kind:'generation',private_message:'hello',wallet_mode:'encrypted'},
  ],spent:[]}]);
  assert.deepEqual(Array.from(await h.api.commands.activity(),e=>e.amount),['2']);
  h.settings.network='testnet';
  // Activity is also isolated by network. Put the same records into the test network.
  await h.api.recordBlockEvents(h.key,[{height:101,timestamp_ms:Date.now(),received:[{aocl_index:2,amount:'3',address_kind:'ec-hybrid',wallet_mode:'refresh'},{aocl_index:3,amount:'4',address_kind:'generation',private_message:'hello',wallet_mode:'encrypted'}],spent:[]}]);
  await h.api.commands.createSubwallet({mode:'refresh'});
  assert.deepEqual(Array.from(await h.api.commands.activity(),e=>e.amount),['3']);
  await h.api.commands.createSubwallet({mode:'encrypted'});
  assert.deepEqual(Array.from(await h.api.commands.activity(),e=>e.amount),['4']);
});

test('seed recovery discovers funded optional wallets and home shows only the selected balance',async()=>{
  const h=await harness();h.settings.network='testnet';
  const bytes=new TextEncoder().encode(JSON.stringify({height:100,watch:[],balances:{standard:'2',refresh:'3',encrypted:'4'},coins:[{profile:'refresh'},{profile:'encrypted'}]}));
  await h.api.saveSnapshot(h.key,100,bytes,'testnet');h.api.dropWallet();
  let home=await h.api.commands.home();assert.equal(home.summary.available,'2');
  assert.equal(home.createdWallets.refresh,true);assert.equal(home.createdWallets.encrypted,true);
  await h.api.commands.selectMode({mode:'encrypted'});home=await h.api.commands.home();assert.equal(home.summary.available,'4');
  await h.api.commands.selectMode({mode:'refresh'});home=await h.api.commands.home();assert.equal(home.summary.available,'3');
});

test('encrypted recovery export requires the current wallet password',async()=>{
  const h=await harness();
  await assert.rejects(h.api.commands.exportRecovery({password:'unused'}),/only available/);
  await h.api.commands.createSubwallet({mode:'refresh'});
  await assert.rejects(h.api.commands.exportRecovery({password:'unused'}),/only available/);
  h.settings.network='testnet';await h.api.saveSnapshot(h.key,100,h.initial,'testnet');h.api.dropWallet();
  await h.api.commands.createSubwallet({mode:'encrypted'});
  h.vault.checkPassword=async password=>{if(password!=='correct password')throw Error('Wrong password');return Array(18).fill('test').join(' ');};
  await assert.rejects(h.api.commands.exportRecovery({password:'wrong'}),/password/);
  const text=await h.api.commands.exportRecovery({password:'correct password'});
  assert.equal(JSON.parse(text).format,'escanour-encrypted-recovery');
  assert.ok(!text.includes(Array(18).fill('test').join(' ')));
});

test('watch adds/removes survive rollback and use monotonic IDs',async()=>{
  const h=await harness();
  await h.api.commands.watchAdd({label:'Atlas',viewingKey:'nolgavk1test',from:'start',mode:'private'});
  await h.api.commands.watchAdd({label:'Atlas',viewingKey:'nechvk1test',from:'start',mode:'fast'});
  assert.equal((await h.api.commands.watchList()).list.length,2);
  await h.api.saveSnapshot(h.key,100,h.initial,'main');h.api.dropWallet();
  assert.equal((await h.api.commands.watchList()).list.length,2);
  await h.api.commands.watchRemove({id:1});
  await h.api.saveSnapshot(h.key,100,h.initial,'main');h.api.dropWallet();
  assert.deepEqual(Array.from((await h.api.commands.watchList()).list,a=>a.id),[2]);
  await h.api.commands.watchAdd({label:'Third',viewingKey:'nolgavk2test',from:'now'});
  assert.deepEqual(Array.from((await h.api.commands.watchList()).list,a=>a.id),[2,3]);
  const stored=h.maps.kv.get('watchData:main');
  assert.ok(stored.iv && stored.data);assert.ok(!new TextDecoder().decode(stored.data).includes('nolgavk'));
});
test('pause, resume and asset hiding persist through worker cache reset',async()=>{
  const h=await harness();await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start'});
  await h.api.commands.watchUpdate({id:1,paused:true,hidden:true});h.api.dropWallet();
  let a=(await h.api.commands.watchList()).list[0];assert.equal(a.paused,true);assert.equal(a.hidden,true);
  await h.api.commands.watchUpdate({id:1,paused:false});a=(await h.api.commands.watchList()).list[0];assert.equal(a.paused,false);assert.equal(a.hidden,true);
});
test('paired contact updates preserve both address kinds and reject duplicates',async()=>{
  const h=await harness();let list=await h.api.commands.saveContact({name:'Atlas',addresses:['nolga1abc','nech1abc']});
  assert.equal(list[0].addresses.length,2);
  await assert.rejects(h.api.commands.saveContact({name:'Duplicate',address:'nech1abc'}),/DUPLICATE/);
  await assert.rejects(h.api.commands.saveContact({name:'Two generation',addresses:['nolga1new','nolga1other']}),/one Generation/);
  list=await h.api.commands.saveContact({id:list[0].id,name:'Atlas updated',addresses:['nolga1abc','nech1abc']});assert.equal(list.length,1);assert.equal(list[0].name,'Atlas updated');
});
test('concurrent status writes preserve both wallet and watch progress',async()=>{
  const h=await harness();await Promise.all([h.api.setStatus({height:123}),h.api.setStatus({watchBehind:{at:45,end:123}})]);
  const s=await h.api.status();assert.equal(s.height,123);assert.equal(s.watchBehind.at,45);
});

test('refresh acknowledges without waiting for the wallet lock or duplicating a queued scanner',async()=>{
 const h=await harness();let release,entered;const started=new Promise(r=>{entered=r;});
 const held=h.api.exclusive(async()=>{entered();await new Promise(r=>{release=r;});});await started;
 let requests=0;h.rpc.post=async()=>{requests++;throw Error('node offline');};
 const a=await h.api.commands.requestSync({networkContext:'main'}),b=await h.api.commands.requestSync({networkContext:'main'});
 assert.equal(a.queued,true);assert.equal(b.network,'main');assert.equal(requests,0);
 release();await held;await h.api.commands.sync().catch(()=>{});assert.equal(requests,1);
 assert.equal((await h.api.status()).checking,false);assert.match((await h.api.status()).error,/node offline/);
});
test('refresh rejects a stale network or locked wallet before requesting a scan',async()=>{
 const h=await harness();let requests=0;h.rpc.post=async()=>{requests++;return '';};
 await assert.rejects(h.api.commands.requestSync({networkContext:'testnet'}),/network changed/);
 h.vault.sessionKey=async()=>null;
 await assert.rejects(h.api.commands.requestSync({networkContext:'main'}),/locked/);assert.equal(requests,0);
});

test('an interrupted watch scan keeps the last committed block checkpoint',async()=>{
  const h=await harness();await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start'});
  h.rpc.post=async(url,body)=>{if(JSON.parse(body).from>2)throw Error('SCAN_INTERRUPTED');return body;};
  const {wallet}=await h.api.requireWallet();const snap=await h.api.latestSnapshot(h.key);
  await assert.rejects(h.api.watchCatchUp({key:h.key,wallet,server:'https://example.invalid/',snap}),/SCAN_INTERRUPTED/);
  h.api.dropWallet();
  assert.equal((await h.api.commands.watchList()).list[0].scanned_to,2);
});

test('indexed scanning resumes an encrypted checkpoint returned by typed-array WASM bindings',async()=>{
  const h=await harness();let flags=0,freed=0;
  h.light.WatchFastScan=class {
    constructor(){this.n=0;}
    static fromBytes(bytes){const x=new this();x.n=JSON.parse(new TextDecoder().decode(bytes)).n;return x;}
    toBytes(){return new TextEncoder().encode(JSON.stringify({n:this.n}));}
    height(){return 100;} found(){return this.n;}
    flagsRequest(){flags++;return '{}';}
    heights(){return new Float64Array(Array.from({length:13},(_,i)=>i+1));}
    scan(){this.n++;} spentRequest(){return undefined;}
    finish(bytes){const state=JSON.parse(new TextDecoder().decode(bytes));state.watch[0].scanned_to=100;return new TextEncoder().encode(JSON.stringify(state));}
    free(){freed++;}
  };
  await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start',mode:'fast'});
  const {wallet}=await h.api.requireWallet();const snap=await h.api.latestSnapshot(h.key);
  const account=(await h.api.commands.watchList()).list[0];
  const args={key:h.key,wallet,server:'https://example.invalid/',snap,account,pref:{mode:'fast'},net:'main'};
  assert.equal(await h.api.watchFastStep(args),true);
  const box=h.maps.kv.get('watchFast:main:1');
  const task=JSON.parse(new TextDecoder().decode(await h.vault.decrypt(h.key,box)));
  assert.ok(Array.isArray(task.heights));assert.equal(task.next,12);
  assert.equal(await h.api.watchFastStep(args),false);
  assert.equal(flags,1);assert.equal(freed,1);assert.equal(h.maps.kv.has('watchFast:main:1'),false);
  assert.equal((await h.api.commands.watchList()).list[0].scanned_to,100);
});

test('empty watch block responses surface an error instead of looping forever',async()=>{
  const h=await harness();await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start'});
  const {wallet}=await h.api.requireWallet();wallet.watchCatchUpFor=()=>({result:{scanned:0}});
  const snap=await h.api.latestSnapshot(h.key);
  await assert.rejects(h.api.watchCatchUp({key:h.key,wallet,server:'https://example.invalid/',snap}),/no usable watch blocks/);
});


test('recipient messages are encrypted at rest and saving fails closed on lock',async()=>{
  const h=await harness();const message='Private memo — مرحبا';
  await h.api.saveSend({id:'private-send',network:'main',to:'nescan1public',privateMessage:message,notificationMode:'private',status:'starting'});
  const raw=h.maps.sends.get('private-send');
  assert.equal(raw.privateMessage,undefined);assert.equal(raw.to,undefined);assert.ok(raw.sealed);
  assert.equal((await h.api.getSend('private-send')).privateMessage,message);
  const event={height:101,timestamp_ms:Date.now(),received:[{aocl_index:1,amount:'7',is_change:false,address_kind:'ec-hybrid',private_message:message}],spent:[]};
  await h.api.recordBlockEvents(h.key,[event]);
  const activity=await h.api.readActivity(h.key);
  assert.equal(activity[0].encryptedMessage,message);assert.equal(activity[0].addressKind,'private-app');
  await h.api.recordBlockEvents(h.key,[{...event,height:102,received:[{...event.received[0],aocl_index:2,address_kind:'private-unprotected'}]}]);
  const exposed=(await h.api.readActivity(h.key)).find(e=>e.height===102);
  assert.equal(exposed.privateDowngrade,true);assert.equal(exposed.addressKind,'private-unprotected');
  assert.equal(exposed.encryptedMessage,message);
  const stored=h.maps.kv.get('activity:main');assert.ok(stored.iv&&stored.data);
  assert.ok(!JSON.stringify(stored).includes(message));
  h.vault.sessionKey=async()=>null;
  await assert.rejects(h.api.saveSend({id:'locked-send',privateMessage:message}),/locked/);
  assert.equal(h.maps.sends.has('locked-send'),false);
});

test('asset recovery offers all three modes for every sub-wallet and keeps known funds until indexed recovery finishes',async()=>{
  for(const profile of ['standard','refresh','encrypted']) for(const mode of ['fast','private','node']) {
    const h=await harness();h.settings.network='testnet';h.settings.activeMode=profile;h.settings.privateNotifications=true;h.settings.autoRefresh=true;h.settings.createdWallets={standard:true,refresh:true,encrypted:true};
    const original=new TextEncoder().encode(JSON.stringify({height:100,watch:[],coins:[{profile:'standard'},{profile:'refresh'},{profile:'encrypted'}]}));
    await h.api.saveSnapshot(h.key,100,original,'testnet');h.api.dropWallet();
    const result=await h.api.commands.rescan({mode,birthday:0,walletMode:profile,nodeUrl:'http://127.0.0.1:9797/'});
    assert.equal(result.mode,mode);assert.equal(result.walletMode,profile);
    const status=await h.api.status();assert.equal(status.fastPending,mode==='private'?null:mode);
    assert.equal(h.settings.recoveryModes[profile],mode);
    const snapshot=await h.api.latestSnapshot(h.key),state=JSON.parse(new TextDecoder().decode(snapshot.state));
    if(mode==='private'){assert.equal(snapshot.height,0);assert.equal(state.expected.length,3);}
    else {assert.equal(snapshot.height,100);assert.equal(state.coins.length,3);}
    if(mode==='node')assert.equal(h.settings.servers.testnet.sync,'http://127.0.0.1:9797/');
  }
});

test('encrypted receipt recovery is rejected outside Encrypted and stale wallet selections cannot start recovery',async()=>{
  const h=await harness();
  await assert.rejects(h.api.commands.rescan({encryptedOnly:true}),/only available/);
  await assert.rejects(h.api.commands.rescan({walletMode:'refresh'}),/changed/);
  await assert.rejects(h.api.commands.rescan({mode:'unknown'}),/Unknown recovery/);
});

test('seed restoration from explicit block zero preserves all three selected recovery modes',async()=>{
  for(const restoreMode of ['fast','private','node']) {
    const h=await harness();
    await h.api.commands.create({password:'test-only-password',phrase:Array(18).fill('mock').join(' '),network:'main',birthday:0,restoreMode,nodeUrl:'http://127.0.0.1:9797/'});
    const status=await h.api.status();assert.equal(status.restored,true);assert.equal(status.recoveryMode,restoreMode);assert.equal(status.fastPending,restoreMode==='private'?null:restoreMode);
  }
});

test('indexed recovery at an existing tip rechecks seeded coins and saves the recovered state',async()=>{
  const h=await harness();let seeded=false,freed=false;
  h.light.FastRestore=class {
    seedState(state){seeded=Boolean(state);this.state=state;this.asked=false;}
    flagsRequest(){if(this.asked)return undefined;this.asked=true;return '{}';}
    heightsToFetch(){return new Float64Array();}restoreChunks(){return 0;}snapshotHeight(){return 100;}
    finish(){return {height:100,state:this.state,events:[]};}free(){freed=true;}
  };
  const {wallet}=await h.api.requireWallet(),snap=await h.api.latestSnapshot(h.key);
  const out=await h.api.runFastRestore({key:h.key,wallet,s:h.settings,server:'https://example.invalid/',st:{fastPending:'fast',recoveryStart:0},snap});
  assert.equal(out.height,100);assert.equal(seeded,true);assert.equal(freed,true);assert.equal((await h.api.status()).fastFailed,null);
});

test('an unavailable index falls back to genesis while retaining previously known receipts',async()=>{
  const h=await harness();
  const state=new TextEncoder().encode(JSON.stringify({height:100,watch:[],coins:[{profile:'refresh',id:'known-offchain'}]}));
  await h.api.saveSnapshot(h.key,100,state,'main');
  h.light.FastRestore=class {seedState(){}flagsRequest(){return '{}';}free(){}};
  h.rpc.post=async()=>{throw Error('method unavailable');};
  const {wallet}=await h.api.requireWallet(),snap=await h.api.latestSnapshot(h.key);
  const out=await h.api.runFastRestore({key:h.key,wallet,s:h.settings,server:'https://example.invalid/',st:{fastPending:'fast',recoveryStart:0},snap});
  assert.equal(out.height,0);assert.equal(JSON.parse(new TextDecoder().decode(out.state)).expected[0].id,'known-offchain');
  assert.equal((await h.api.status()).fastFailed,'unsupported');assert.equal((await h.api.status()).fastPending,null);
});

test('payment-code recovery and waiting receipts stay in the selected sub-wallet',async()=>{
  const h=await harness();h.settings.network='testnet';h.settings.createdWallets={standard:true,refresh:true,encrypted:true};h.settings.autoRefresh=true;h.settings.privateNotifications=true;
  await h.api.saveSnapshot(h.key,100,new TextEncoder().encode(JSON.stringify({height:100,watch:[],expected:['standard','refresh','encrypted'].map(profile=>({profile,addition_record:profile}))})),'testnet');
  for(const profile of ['standard','refresh','encrypted']) {
    await h.api.commands.selectMode({mode:profile});
    assert.deepEqual(Array.from((await h.api.commands.waiting()).list,c=>c.profile),[profile]);
    assert.equal((await h.api.commands.claimCheck({text:profile})).profile,profile);
    assert.equal((await h.api.commands.claimRegister({text:profile})).profile,profile);
    const other=profile==='standard'?'refresh':'standard';
    await assert.rejects(h.api.commands.claimCheck({text:other}),/another sub-wallet/);
    await assert.rejects(h.api.commands.claimRemove({record:other}),/selected sub-wallet/);
  }
});

test('viewing-key export uses current Standard or Auto-refresh addresses and cannot mislabel Encrypted',async()=>{
  const h=await harness();h.vault.checkPassword=async()=>'';
  assert.equal((await h.api.commands.viewingKeys({password:'test'})).profile,'standard');
  h.settings.network='testnet';await h.api.saveSnapshot(h.key,100,new TextEncoder().encode(JSON.stringify({height:100,watch:[],receiveIndex:4})),'testnet');
  await h.api.commands.createSubwallet({mode:'refresh'});
  const keys=await h.api.commands.viewingKeys({password:'test'});assert.equal(keys.profile,'refresh');assert.equal(keys.index,4);
  await h.api.commands.createSubwallet({mode:'encrypted'});await assert.rejects(h.api.commands.viewingKeys({password:'test'}),/not supported/);
});

test('Own node recovery updates Tor host rules before using a new node',async()=>{
  const h=await harness();h.settings.tor=true;let proxy;
  h.chrome.proxy={settings:{get:async()=>({levelOfControl:'controlled_by_this_extension'}),set:async config=>{proxy=config.value;}}};
  await h.api.setTorState({state:'on'});
  await h.api.configureRecoveryNode(h.settings,'main','https://owned-node.example/');
  assert.equal(h.settings.servers.main.sync,'https://owned-node.example/');
  assert.equal(proxy.mode,'pac_script');assert.equal(proxy.pacScript.mandatory,true);assert.ok(proxy.pacScript.data.includes('owned-node.example'));
});

test('recovery cannot forget reservations or interrupt an active outgoing payment in any sub-wallet',async()=>{
  const h=await harness();await h.api.saveSend({id:'pending-proof',network:'main',walletMode:'refresh',status:'proving'});
  await assert.rejects(h.api.commands.rescan({mode:'fast'}),/payment is still pending/);
  assert.equal((await h.api.latestSnapshot(h.key)).height,100);
  h.maps.sends.clear();
  await h.api.saveSnapshot(h.key,100,new TextEncoder().encode(JSON.stringify({height:100,watch:[],coins:[{profile:'encrypted',reserved:true,spent_height:null}]})),'main');
  await assert.rejects(h.api.commands.rescan({mode:'private'}),/payment is still pending/);
  assert.equal((await h.api.latestSnapshot(h.key)).height,100);
});

test('a later scan start cannot hide already known receipts and fractional block heights are rejected',async()=>{
  const h=await harness();
  await h.api.saveSnapshot(h.key,100,new TextEncoder().encode(JSON.stringify({height:100,watch:[],coins:[{profile:'refresh',received_height:12}]})),'main');
  const result=await h.api.commands.rescan({birthday:50,mode:'private'});
  assert.equal(result.start,11);assert.equal((await h.api.latestSnapshot(h.key)).height,11);
  await assert.rejects(h.api.commands.rescan({birthday:1.5}),/Not a block height/);
  await assert.rejects(h.api.commands.rescan({birthday:9007199254740992}),/Not a block height/);
});

test('concurrent send requests create one active payment and recovery blocks new sends until caught up',async()=>{
  const h=await harness();
  const request={to:'nolga1mock',amount:'1',fee:'0.1',waitForFreshBlock:true};
  const results=await Promise.allSettled([h.api.commands.send(request),h.api.commands.send(request)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(h.maps.sends.size,1);
  const recovering=await harness();await recovering.api.setStatus({height:50,tip:100,fastPending:'fast'});
  await assert.rejects(recovering.api.commands.send(request),/recovery or syncing/);assert.equal(recovering.maps.sends.size,0);
});


test('phrase and viewing-key exports require an unlocked wallet throughout password verification',async()=>{
  for(const command of ['revealPhrase','viewingKeys']) {
    const h=await harness();let checks=0;
    h.vault.checkPassword=async()=>{checks++;return 'mock phrase';};
    h.vault.sessionKey=async()=>null;h.api.dropWallet();
    await assert.rejects(h.api.commands[command]({password:'test'}),/locked/);assert.equal(checks,0);
    h.vault.sessionKey=async()=>h.key;
    h.vault.checkPassword=async()=>{h.vault.sessionKey=async()=>null;h.api.dropWallet();return 'mock phrase';};
    await assert.rejects(h.api.commands[command]({password:'test'}),/locked/);
  }
});
test('viewing-key export rejects a sub-wallet switch during password verification',async()=>{
  const h=await harness();h.settings.createdWallets.refresh=true;h.settings.autoRefresh=true;
  h.vault.checkPassword=async()=>{h.settings.activeMode='refresh';return 'mock phrase';};
  await assert.rejects(h.api.commands.viewingKeys({password:'test'}),/changed/);
});
test('encrypted recovery-file export cannot finish after a lock or sub-wallet switch',async()=>{
  for(const change of ['lock','mode']) {
    const h=await harness();h.settings.network='testnet';await h.api.saveSnapshot(h.key,100,h.initial,'testnet');h.api.dropWallet();
    await h.api.commands.createSubwallet({mode:'encrypted'});
    h.vault.checkPassword=async()=>{if(change==='lock'){h.vault.sessionKey=async()=>null;h.api.dropWallet();}else h.settings.activeMode='standard';return Array(18).fill('mock').join(' ');};
    await assert.rejects(h.api.commands.exportRecovery({password:'test-only-password'}),/locked|changed/);
  }
});

async function uncertainPayment() {
  const h=await harness();
  const prepared=new TextEncoder().encode('exact prepared transaction');
  const rec={id:'uncertain-send',network:'main',walletMode:'standard',status:'submitting',to:'nolga1mock',amount:'1',fee:'0.1',createdAt:Date.now(),attempt:1,jobCount:1,prepared:await h.vault.encrypt(h.key,prepared),view:{tx_id:'same-tx',amount:'1',fee:'0.1',change:'0',input_aocl_indices:[1]}};
  await h.api.saveSend(rec);h.maps.proofs.set('uncertain-send:0','exact proof');
  const {wallet}=await h.api.requireWallet();let reserves=0;
  wallet.recordBroadcast=(state,p)=>{assert.equal(new TextDecoder().decode(p),'exact prepared transaction');reserves++;return state;};
  return {...h,prepared,reserves:()=>reserves};
}
test('a lost broadcast response preserves the original payment and blocks new sends or recovery',async()=>{
  const h=await uncertainPayment();
  h.maps.kv.set('submit:uncertain-send',{ok:false,uncertain:true,error:'Failed to fetch'});
  await h.api.handleSubmitted('uncertain-send');
  const rec=await h.api.getSend('uncertain-send');assert.equal(rec.status,'uncertain');assert.ok(rec.prepared);assert.equal(h.reserves(),1);
  assert.equal(h.maps.proofs.get('uncertain-send:0'),'exact proof');
  const events=await h.api.readActivity(h.key);assert.equal(events.length,1);assert.equal(events[0].broadcastUncertain,true);
  await h.api.expireOldSends(h.key,1000);assert.equal((await h.api.readActivity(h.key))[0].status,'pending');
  await assert.rejects(h.api.commands.send({to:'nolga1mock',amount:'1',fee:'0.1'}),/still being sent/);
  await assert.rejects(h.api.commands.rescan({mode:'private'}),/payment is still pending/);
});
test('a rejection after an uncertain upload cannot discard the original; acceptance resolves it once',async()=>{
  const h=await uncertainPayment();
  for(const result of [{ok:false,uncertain:true,error:'timeout'},{ok:false,error:'not confirmable'}]) {
    h.maps.kv.set('submit:uncertain-send',result);await h.api.handleSubmitted('uncertain-send');
    assert.equal((await h.api.getSend('uncertain-send')).status,'uncertain');assert.equal(h.maps.proofs.size,1);
  }
  assert.equal(h.reserves(),1);
  h.maps.kv.set('submit:uncertain-send',{ok:true});await h.api.handleSubmitted('uncertain-send');
  const rec=await h.api.getSend('uncertain-send');assert.equal(rec.status,'done');assert.equal(rec.prepared,undefined);assert.equal(h.maps.proofs.size,0);
  const events=await h.api.readActivity(h.key);assert.equal(events.length,1);assert.equal(events[0].broadcastUncertain,false);
  await assert.rejects(h.api.commands.retrySend({id:'uncertain-send'}),/Only a failed/);
});
test('chain confirmation resolves an uncertain payment without another upload',async()=>{
  const h=await uncertainPayment();h.maps.kv.set('submit:uncertain-send',{ok:false,uncertain:true});await h.api.handleSubmitted('uncertain-send');
  await h.api.recordBlockEvents(h.key,[{height:101,timestamp_ms:Date.now(),received:[],spent:[{aocl_index:1,tx_id:'same-tx',wallet_mode:'standard',amount:'1.1'}]}]);
  await h.api.resumeSends();assert.equal((await h.api.getSend('uncertain-send')).status,'done');assert.equal(h.maps.proofs.size,0);
});


test('retrying an uncertain payment dispatches its exact original prepared transaction and proofs',async()=>{
  const h=await uncertainPayment();h.maps.kv.set('submit:uncertain-send',{ok:false,uncertain:true});await h.api.handleSubmitted('uncertain-send');
  const original=(await h.api.getSend('uncertain-send')).prepared;const sent=[];
  h.vault.sessionKeyRaw=async()=>new Uint8Array(32);
  h.chrome.offscreen={createDocument:async()=>{},closeDocument:async()=>{}};
  h.chrome.runtime.sendMessage=async msg=>{if(msg.target==='offscreen')sent.push(msg);};
  assert.equal(await h.api.commands.retrySend({id:'uncertain-send'}),'uncertain-send');
  const after=await h.api.getSend('uncertain-send');assert.equal(after.status,'submitting');assert.equal(after.broadcastUncertain,true);
  assert.equal(h.maps.sends.size,1);assert.deepEqual(after.prepared,original);assert.equal(h.maps.proofs.get('uncertain-send:0'),'exact proof');
  assert.deepEqual(sent.map(s=>[s.type,s.sendId]),[['submit','uncertain-send']]);
  await assert.rejects(h.api.commands.retrySend({id:'uncertain-send'}),/Only a failed/);
});


test('each sub-wallet remembers a separate asset-recovery method',async()=>{
  const h=await harness();h.settings.network='testnet';await h.api.saveSnapshot(h.key,100,h.initial,'testnet');h.api.dropWallet();
  h.settings.createdWallets={standard:true,refresh:true,encrypted:true};h.settings.autoRefresh=true;h.settings.privateNotifications=true;
  for(const [profile,mode] of [['standard','fast'],['refresh','private'],['encrypted','node']]) {
    await h.api.commands.selectMode({mode:profile});await h.api.commands.rescan({walletMode:profile,mode,nodeUrl:'http://127.0.0.1:9797/'});
    assert.equal(h.settings.recoveryModes[profile],mode);
  }
  assert.equal(h.settings.recoveryModes.standard,'fast');assert.equal(h.settings.recoveryModes.refresh,'private');assert.equal(h.settings.recoveryModes.encrypted,'node');
});
test('sub-wallet indexed recovery explicitly scopes its flags and keeps other wallets during merge',async()=>{
  const h=await harness();let selected;
  h.light.FastRestore=class {
    static forProfile(profile){selected=profile;return new this();}
    seedState(state){this.state=state;this.asked=false;}flagsRequest(){if(this.asked)return undefined;this.asked=true;return '{}';}
    heightsToFetch(){return [];}restoreChunks(){return 0;}snapshotHeight(){return 100;}
    finish(){return {height:100,state:new TextEncoder().encode(JSON.stringify({height:100,watch:[],coins:[{profile:'standard',id:'new-standard'}]})),events:[]};}free(){}
  };
  await h.api.saveSnapshot(h.key,100,new TextEncoder().encode(JSON.stringify({height:100,watch:[],coins:[{profile:'refresh',id:'keep-private'}]})),'main');
  const {wallet}=await h.api.requireWallet(),snap=await h.api.latestSnapshot(h.key);
  const out=await h.api.runFastRestore({key:h.key,wallet,s:h.settings,server:'https://example.invalid/',st:{fastPending:'fast',recoveryWallet:'standard',recoveryStart:0},snap});
  assert.equal(selected,'standard');assert.equal(JSON.parse(new TextDecoder().decode(out.state)).coins.find(c=>c.profile==='refresh').id,'keep-private');
});


test('payment codes register once and can be removed only from their own sub-wallet',async()=>{
  const h=await harness();h.settings.network='testnet';h.settings.autoRefresh=true;h.settings.privateNotifications=true;h.settings.createdWallets={standard:true,refresh:true,encrypted:true};
  await h.api.saveSnapshot(h.key,100,h.initial,'testnet');h.api.dropWallet();
  for(const profile of ['standard','refresh','encrypted']) {
    await h.api.commands.selectMode({mode:profile});const args={text:profile,walletMode:profile,networkContext:'testnet'};
    assert.equal((await h.api.commands.claimCheck(args)).status,'new');assert.equal((await h.api.commands.claimRegister(args)).status,'new');
    assert.equal((await h.api.commands.claimRegister(args)).status,'waiting');
    assert.equal((await h.api.commands.waiting(args)).list.length,1);
    await h.api.commands.claimRemove({record:profile,...args});assert.equal((await h.api.commands.waiting(args)).list.length,0);
  }
});
test('payment-code actions reject stale wallet/network contexts and oversize input',async()=>{
  const h=await harness();
  for(const cmd of ['claimCheck','claimRegister','claimRemove','waiting']) {
    await assert.rejects(h.api.commands[cmd]({text:'standard',record:'standard',walletMode:'refresh',networkContext:'main'}),/changed/);
    await assert.rejects(h.api.commands[cmd]({text:'standard',record:'standard',walletMode:'standard',networkContext:'testnet'}),/changed/);
  }
  for(const text of ['', 'x'.repeat(65537), {}, null])await assert.rejects(h.api.commands.claimCheck({text}));
});
test('a queued payment-code registration cannot move to a different selected sub-wallet',async()=>{
  const h=await harness();let release,queued;
  const entered=new Promise(resolve=>{release=resolve;});let signalEntered;
  const holding=new Promise(resolve=>{signalEntered=resolve;});
  const hold=h.api.exclusive(async()=>{signalEntered();await entered;});await holding;
  const arrived=new Promise(resolve=>{queued=resolve;});h.rpc.interrupt=()=>queued();
  const register=h.api.commands.claimRegister({text:'standard',walletMode:'standard',networkContext:'main'});await arrived;
  h.settings.createdWallets.refresh=true;h.settings.autoRefresh=true;h.settings.activeMode='refresh';release();await hold;
  await assert.rejects(register,/changed/);
  assert.equal((await h.api.commands.waiting()).list.length,0);
});
test('cancelling a queued code registration makes no wallet-state change',async()=>{
  const h=await harness();await h.api.commands.cancelJob({jobId:'cancel-code'});
  await assert.rejects(h.api.commands.claimRegister({text:'standard',jobId:'cancel-code'}),/CANCELLED/);
  assert.equal((await h.api.commands.waiting()).list.length,0);
});
test('archive-adoption results cannot leak between sub-wallet waiting lists',async()=>{
  const h=await harness();await h.api.setStatus({lastAdopted:{list:[{wallet_mode:'standard',amount:'1'},{wallet_mode:'refresh',amount:'2'},{wallet_mode:'encrypted',amount:'3'}]}});
  assert.deepEqual(Array.from((await h.api.commands.waiting()).lastAdopted.list,c=>c.amount),['1']);
  h.settings.createdWallets.refresh=true;h.settings.autoRefresh=true;h.settings.activeMode='refresh';assert.deepEqual(Array.from((await h.api.commands.waiting()).lastAdopted.list,c=>c.amount),['2']);
});
test('manual block scans preserve saved recovery choices and reject stale network context',async()=>{
  const h=await harness();h.settings.recoveryModes={standard:'fast',refresh:'node',encrypted:'private'};
  await assert.rejects(h.api.commands.rescan({mode:'private',networkContext:'testnet'}),/network changed/);
  await h.api.commands.rescan({mode:'private',rememberMode:false,networkContext:'main'});
  assert.equal(h.settings.recoveryModes.standard,'fast');assert.equal(h.settings.recoveryModes.refresh,'node');
});
test('premine search is limited to Standard and notification arithmetic keeps sub-pico NPT',async()=>{
  const h=await harness();h.settings.createdWallets.refresh=true;h.settings.autoRefresh=true;h.settings.activeMode='refresh';await assert.rejects(h.api.commands.findPremine({}),/Standard/);
  assert.equal(h.api.plus('1.0000000000001','0.0000000000002'),'1.0000000000003');
});


test('fresh-block waiting follows the Advanced preference and defaults off even if a caller forces it on',async()=>{
 for(const enabled of [false,true]) {
  const h=await harness();h.settings.waitForFreshBlock=enabled;
  h.rpc.post=async()=>{throw Error('test node');};
  const id=await h.api.commands.send({to:'nolga1mock',amount:'1',fee:'0.1',waitForFreshBlock:!enabled});
  assert.equal((await h.api.getSend(id)).waitForFreshBlock,enabled);
 }
 const h=await harness();await h.api.commands.saveSettings({waitForFreshBlock:true});assert.equal(h.settings.sendTimingConfigured,true);
 await assert.rejects(h.api.commands.send({to:'nolga1mock',amount:'1',fee:'0.1',networkContext:'testnet'}),/Network changed/);
});
test('sending checks the wallet tip without waiting for archive or spend-index maintenance',async()=>{
 const h=await harness();h.settings.exactPrivacy=true;h.settings.localArchive=true;
 await h.api.setStatus({height:100,tip:100,serverOk:true});
 const rpcCalls=[],stages=[];h.chrome.runtime.sendMessage=async msg=>{if(msg.type==='send')stages.push(msg.send.status);};
 h.rpc.post=async(url,body)=>{rpcCalls.push(JSON.parse(body));return JSON.stringify({result:{height:100}});};
 let built=false;h.light.LightWallet.prototype.prepareSend=()=>{built=true;throw Error('fixture: preparation reached');};
 await h.api.saveSend({id:'build',status:'waiting-block',walletMode:'standard',network:'main',createdAt:Date.now(),attempt:1,waitForFreshBlock:true});
 await h.api.runSend('build');assert.equal(built,true);assert.equal(rpcCalls.length,1);assert.equal(rpcCalls[0].method,'chain_height');assert(stages.includes('checking'));assert(stages.includes('preparing'));assert.equal((await h.api.getSend('build')).waitForFreshBlock,false);
});
test('a send cancelled during its tip check never builds or uploads a transaction',async()=>{
 const h=await harness();let reply,entered;const begun=new Promise(r=>{entered=r;});
 h.rpc.post=async()=>{entered();return new Promise(r=>{reply=r;});};let built=false;
 h.light.LightWallet.prototype.prepareSend=()=>{built=true;throw Error('must not build');};
 await h.api.saveSend({id:'cancel-check',status:'starting',walletMode:'standard',network:'main',createdAt:Date.now(),attempt:1,waitForFreshBlock:false});
 const running=h.api.runSend('cancel-check');await begun;await h.api.commands.cancelSend({id:'cancel-check'});reply(JSON.stringify({result:{height:100}}));await running;
 assert.equal(built,false);assert.equal((await h.api.getSend('cancel-check')).status,'cancelled');
});
test('send controls cannot dismiss, cancel or approve another sub-wallet payment',async()=>{
 const h=await harness();await h.api.saveSend({id:'other',status:'needs-lustration',network:'main',walletMode:'refresh'});
 for(const cmd of ['dismissSend','cancelSend','acceptLustrationAndRetry'])await assert.rejects(h.api.commands[cmd]({id:'other'}),/sub-wallet/);
 assert.equal((await h.api.getSend('other')).status,'needs-lustration');
});
test('recovery can pause at its saved checkpoint, remain paused on alarms and resume',async()=>{
 const h=await harness();await h.api.setStatus({height:100,tip:120,recoveryMode:'private',recoveryWallet:'standard',syncing:true});
 const paused=await h.api.commands.pauseRecovery({walletMode:'standard',networkContext:'main'});assert.equal(paused.status.scanPaused,true);assert.equal(paused.status.height,100);
 let requests=0;h.rpc.post=async()=>{requests++;throw Error('offline');};await h.api.commands.sync();assert.equal(requests,0);
 await assert.rejects(h.api.commands.requestSync({networkContext:'main'}),/paused/);
 const resumed=await h.api.commands.resumeRecovery({walletMode:'standard',networkContext:'main'});assert.equal(resumed.status.scanPaused,false);assert.equal((await h.api.latestSnapshot(h.key)).height,100);
});
test('separate recovery methods and progress survive switching jobs and reject foreign cancellation',async()=>{
 const h=await harness();h.settings.createdWallets.refresh=true;h.settings.autoRefresh=true;
 await h.api.setStatus({height:30,tip:100,recoveryMode:'private',recoveryWallet:'standard',syncing:true});
 await h.api.commands.selectMode({mode:'refresh'});
 await assert.rejects(h.api.commands.pauseRecovery({walletMode:'refresh',networkContext:'main'}),/recovery changed/);
 await h.api.commands.rescan({mode:'fast',birthday:0,walletMode:'refresh',networkContext:'main'});
 const jobs=await h.api.recoveryStatuses();assert.equal(jobs.standard.recoveryMode,'private');assert.equal(jobs.standard.scanPaused,true);assert.equal(jobs.refresh.recoveryMode,'fast');assert.equal(jobs.refresh.scanPaused,false);
 assert.equal(h.settings.recoveryModes.refresh,'fast');
});
test('switching from a rewound Private scan to Fast seeds the encrypted pre-scan checkpoint',async()=>{
 const h=await harness(),encode=o=>new TextEncoder().encode(JSON.stringify(o)),decode=b=>JSON.parse(new TextDecoder().decode(b));
 await h.api.saveSnapshot(h.key,100,encode({height:100,watch:[],coins:[{id:'retained',profile:'standard'}]}));
 await h.api.commands.rescan({mode:'private',birthday:0,walletMode:'standard',networkContext:'main'});
 assert.equal((await h.api.latestSnapshot(h.key)).height,0);const base=h.maps.kv.get('recoveryBase:main');assert(base.box);assert.equal(base.coins,undefined);
 await h.api.commands.rescan({mode:'fast',birthday:0,walletMode:'standard',networkContext:'main'});
 const seeds=[];h.light.FastRestore=class {
  static forProfile(){return new this();}seedState(bytes){seeds.push(decode(bytes));}flagsRequest(){return undefined;}restoreChunks(){return 0;}snapshotHeight(){return 100;}
  finish(){return {height:100,state:encode({height:100,watch:[],coins:[{id:'retained',profile:'standard'}]}),events:[]};}free(){}
 };
 const {wallet}=await h.api.requireWallet();const result=await h.api.runFastRestore({key:h.key,wallet,s:h.settings,server:'https://example.invalid/',st:await h.api.status(),snap:await h.api.latestSnapshot(h.key)});
 assert.equal(result.height,100);assert(seeds.some(st=>st.coins?.some(c=>c.id==='retained')));assert.equal((await h.api.status()).fastFailed,null);
});

test('Fast advances other sub-wallet proofs locally from the retained checkpoint',async()=>{
 const h=await harness(),encode=o=>new TextEncoder().encode(JSON.stringify(o)),decode=b=>JSON.parse(new TextDecoder().decode(b));
 const baseState=encode({height:100,watch:[],coins:[{id:'standard-coin',profile:'standard'},{id:'refresh-coin',profile:'refresh'}]});
 await h.api.saveSnapshot(h.key,100,baseState);await h.api.commands.rescan({mode:'private',birthday:0,walletMode:'standard',networkContext:'main'});
 h.light.FastRestore=class {static forProfile(){return new this();}seedState(){}flagsRequest(){return undefined;}restoreChunks(){return 0;}snapshotHeight(){return 101;}finish(){return {height:101,state:encode({height:101,watch:[],coins:[{id:'standard-coin',profile:'standard'}]}),events:[]};}free(){}};
 let tail=0;h.light.LightWallet.prototype.applyBlocksWatching=(bytes,body)=>{tail++;const st=decode(bytes),range=JSON.parse(body);return {state:encode({...st,height:range.to}),result:{height:range.to,applied:range.to-range.from+1,reorg:false,events:[]}};};
 const {wallet}=await h.api.requireWallet();const out=await h.api.runFastRestore({key:h.key,wallet,s:h.settings,server:'https://example.invalid/',st:{fastPending:'fast',recoveryWallet:'standard',recoveryStart:0},snap:await h.api.latestSnapshot(h.key)});
 assert.equal(out.height,101);assert.equal(tail,1);assert.deepEqual(decode(out.state).coins.map(c=>c.id),['standard-coin','refresh-coin']);assert.equal((await h.api.status()).fastFailed,null);
});
test('replacing an interrupted scan cannot inherit its late error or remain attached to its old run',async()=>{
 const h=await harness();let rejectRequest,entered;const started=new Promise(r=>{entered=r;});
 h.rpc.post=async()=>{entered();return new Promise((_,reject)=>{rejectRequest=reject;});};
 h.rpc.interrupt=()=>rejectRequest?.(Error('SCAN_INTERRUPTED'));
 const scan=h.api.commands.sync();await started;
 await h.api.commands.rescan({mode:'fast',birthday:0,walletMode:'standard',networkContext:'main'});await scan;
 const st=await h.api.status();assert.equal(st.recoveryMode,'fast');assert.equal(st.fastPending,'fast');assert.equal(st.error,null);assert.equal(st.scanPaused,false);
});

test('choosing a recovery method saves only the chosen sub-wallet preference without starting a scan',async()=>{
 const h=await harness();h.settings.recoveryModes={standard:'fast',refresh:'private',encrypted:'private'};
 let calls=0;h.rpc.post=async()=>{calls++;throw Error('must not scan');};
 await h.api.commands.setRecoveryMode({walletMode:'standard',networkContext:'main',mode:'node'});
 assert.equal(h.settings.recoveryModes.standard,'node');assert.equal(h.settings.recoveryModes.refresh,'private');assert.equal(calls,0);
 await assert.rejects(h.api.commands.setRecoveryMode({walletMode:'refresh',networkContext:'main',mode:'fast'}),/wallet changed/);
});

test('node-pool settings require two valid distinct nodes and Own node clears public fallback',async()=>{
 const h=await harness();
 await assert.rejects(h.api.commands.saveSettings({servers:{main:{sync:'https://a.invalid',fallback:'https://a.invalid/',randomFallback:true}}}),/two different/);
 await assert.rejects(h.api.commands.saveSettings({servers:{main:{sync:'https://a.invalid/',fallback:'http://remote.invalid/',randomFallback:true}}}),/https/);
 await h.api.commands.saveSettings({servers:{main:{sync:'https://a.invalid/',fallback:'https://b.invalid/',randomFallback:true}}});
 assert.equal(h.settings.servers.main.fallback,'https://b.invalid/');assert.equal(h.settings.servers.main.randomFallback,true);
 await h.api.configureRecoveryNode(h.settings,'main','http://127.0.0.1:9797/');assert.equal(h.settings.servers.main.randomFallback,false);assert.equal(h.settings.servers.main.fallback,'');
});
test('default broadcasts use the session node, while an explicit separate broadcaster stays selected',async()=>{
 const h=await harness();h.settings.servers.main={sync:'https://a.invalid/',broadcast:'https://a.invalid/',fallback:'https://b.invalid/',randomFallback:true};
 h.rpc.nodeSession=async()=>({url:'https://b.invalid/',enabled:true,nodes:['https://a.invalid/','https://b.invalid/'],label:'B'});
 assert.equal(await h.api.commands.broadcastNode({networkContext:'main'}),'https://b.invalid/');
 h.settings.servers.main.broadcast='https://c.invalid/';assert.equal(await h.api.commands.broadcastNode({networkContext:'main'}),'https://c.invalid/');
 await assert.rejects(h.api.commands.broadcastNode({networkContext:'unknown'}),/Unknown network/);
});
test('privacy reporting accounts for every configured fallback operator',async()=>{
 const h=await harness();h.light.privacyReport=()=>({coins:[]});
 h.settings.servers.main={sync:'https://a.invalid/',broadcast:'https://b.invalid/',fallback:'https://b.invalid/',randomFallback:true};
 h.rpc.nodeSession=async()=>({url:'https://a.invalid/',enabled:true,nodes:['https://a.invalid/','https://b.invalid/'],label:'A'});
 h.maps.kv.set('fastRestored:main',{mode:'fast',server:'http://127.0.0.1:9797/',servers:['https://a.invalid/','http://127.0.0.1:9797/']});
 const report=await h.api.commands.privacy();assert.equal(report.sameServer,true);assert.equal(report.ownNode,false);assert.equal(report.fastRestored.own,false);
});

test('new fallback hosts are blocked until Tor routes have been installed',async()=>{
 const h=await harness();h.settings.tor=true;await h.api.setTorState({state:'on',required:true});let pac='',blocked=false;
 h.rpc.resetNodeSession=async()=>{blocked=(await h.api.commands.torStatus()).state==='connecting';};
 h.chrome.proxy={settings:{get:async()=>({levelOfControl:'controlled_by_this_extension'}),set:async config=>{pac=config.value.pacScript.data;}}};
 await h.api.commands.saveSettings({servers:{main:{sync:'https://a.invalid/',fallback:'https://b.invalid/',randomFallback:true}}});
 assert.equal(blocked,true);assert.match(pac,/a\.invalid/);assert.match(pac,/b\.invalid/);
 // The harness has no Tor checker, so it must stay fail-closed after installation.
 assert.notEqual((await h.api.commands.torStatus()).state,'on');
});
