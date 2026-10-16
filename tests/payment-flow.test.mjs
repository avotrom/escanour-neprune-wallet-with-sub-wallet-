import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8');
const between=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert(start>=0&&end>start);return source.slice(start,end);};
function control(){return {value:'',textContent:'',hidden:true,disabled:false,open:false,children:[],dataset:{},style:{},attributes:{},classList:{add(){},remove(){},toggle(){}},append(...els){this.children.push(...els);},setAttribute(k,v){this.attributes[k]=v;},focus(){}};}
function ui(){
 const controls=new Map(),calls=[],toasts=[],timers=new Map();let timerId=0;const $=id=>{if(!controls.has(id))controls.set(id,control());return controls.get(id);};
 const context=vm.createContext({$,app:{unlocked:true,settings:{activeMode:'standard',network:'main'},status:{}},currentScreen:'payment-codes',secretEpoch:1,SCREENS:[],activeMode:s=>s.activeMode||'standard',
 lastSend:null,renderSendCard:()=>{},sendBelongsHere:()=>true,document:{querySelector:()=>({value:'private'}),querySelectorAll:()=>[],createElement:()=>control()},busy:(b,v)=>{b.disabled=v;},err:(id,e)=>{$(id).textContent=e?String(e.message||e):'';},t:key=>key,fmtAmt:x=>x,fmtNum:x=>x,lang:()=> 'en',kindLabel:x=>x,claimErr:e=>String(e.message||e),toast:x=>toasts.push(x),confirm:()=>true,privateRecoveryStart:h=>Math.max(0,Number(h)-1),
 call:async(cmd,args)=>{calls.push({cmd,args});return {list:[],archive:null};},showScreen:name=>{context.currentScreen=name;context.secretEpoch++;},isLocalUrl:()=>false,cancelAssetRefresh:()=>{},
 setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
 });
 vm.runInContext(between('let claimShown = null,','// -------------------------------------------------------- local archive'),context);
 return {context,$,calls,toasts,timers,expire:()=>{for(const [id,{fn}] of [...timers]){timers.delete(id);fn();}}};
}
test('editing a checked payment code invalidates registration and late check results',async()=>{
 const h=ui();let finish;h.context.call=(cmd,args)=>{h.calls.push({cmd,args});return new Promise(r=>{finish=r;});};
 h.$('claimText').value='code-A';h.$('claimText').oninput();const checking=h.$('claimRead').onclick();
 h.$('claimText').value='code-B';h.$('claimText').oninput();finish({amount:'9',key_kind:'generation',status:'new'});await checking;
 assert.equal(h.$('claimCard').hidden,true);assert.equal(h.$('claimAmount').textContent,'');await h.$('claimGo').onclick();assert.equal(h.calls.length,1);
});
test('leaving payment codes clears the code and blocks a delayed result',async()=>{
 const h=ui();vm.runInContext(between('function showScreen(', 'function openSheet('),h.context);
 let finish;h.context.call=()=>new Promise(r=>{finish=r;});h.$('claimText').value='code-A';h.$('claimText').oninput();const pending=h.$('claimRead').onclick();
 vm.runInContext("showScreen('home')",h.context);finish({amount:'9',key_kind:'generation',status:'new'});await pending;
 assert.equal(h.$('claimText').value,'');assert.equal(h.$('claimAmount').textContent,'');assert.equal(h.$('claimCard').hidden,true);
});
test('the checked code registers with its original wallet and network context',async()=>{
 const h=ui();h.context.call=async(cmd,args)=>{h.calls.push({cmd,args});return cmd==='waiting'?{list:[{amount:'2',addition_record:'r'}]}:{amount:'2',key_kind:'ec-hybrid',status:'new'};};
 h.context.runJob=async({cmd,args})=>({data:await h.context.call(cmd,args)});
 h.$('claimText').value='code-A';h.$('claimText').oninput();await h.$('claimRead').onclick();assert.equal(h.$('claimCard').hidden,false);
 await h.$('claimGo').onclick();const sent=h.calls.find(c=>c.cmd==='claimRegister');assert.equal(sent.args.text,'code-A');assert.equal(sent.args.walletMode,'standard');assert.equal(sent.args.networkContext,'main');assert.equal(h.$('claimText').value,'');assert.equal(h.$('claimWaitingCount').textContent,'1');assert.equal(h.$('claimWaitingPanel').open,true);
});
test('editing the code does not disable unrelated waiting-payment removal',async()=>{
 const h=ui();h.context.call=async(cmd,args)=>{h.calls.push({cmd,args});return {list:[{amount:'2',addition_record:'r'}]};};
 await vm.runInContext('renderWaiting()',h.context);const remove=h.$('claimWaiting').children[0].children[1];
 h.$('claimText').value='another-code';h.$('claimText').oninput();await remove.onclick();await h.$('claimWaiting').children[0].children[2].children[1].children[1].onclick();assert.equal(h.calls.filter(c=>c.cmd==='claimRemove').length,1);
 h.context.secretEpoch++;await remove.onclick();assert.equal(h.calls.filter(c=>c.cmd==='claimRemove').length,1);
});
test('advanced block input rejects fractions and its scan preserves the saved recovery method',async()=>{
 const h=ui();h.context.currentScreen='recovery-options';h.context.call=async(cmd,args)=>{h.calls.push({cmd,args});return cmd==='state'?h.context.app:{start:9};};
 h.$('claimFrom').value='10.5';await h.$('claimRescan').onclick();assert.equal(h.calls.length,0);assert.equal(h.$('claimOptionsError').textContent,'codes.badBlock');
 h.$('claimFrom').value='10';await h.$('claimRescan').onclick();const scan=h.calls.find(c=>c.cmd==='rescan');assert.equal(scan.args.birthday,9);assert.equal(scan.args.mode,'private');assert.equal(scan.args.rememberMode,false);assert.equal(scan.args.networkContext,'main');assert.equal(h.$('claimOptionsError').textContent,'');assert.equal(h.context.currentScreen,'claim');
});
test('balance refresh requests sync once without rescanning or rotating addresses',async()=>{
 const h=ui();let finish;h.context.currentScreen='home';h.context.renderStatus=()=>{};h.context.refreshHome=async()=>true;
 h.context.call=(cmd,args)=>{h.calls.push({cmd,args});return new Promise(r=>{finish=r;});};
 vm.runInContext(between('let assetsRefreshing=false;','// -------------------------------------------------------------- balance'),h.context);
 const pending=h.$('refreshAssets').onclick();await h.$('refreshAssets').onclick();assert.equal(h.calls.length,1);assert.equal(h.calls[0].cmd,'requestSync');assert.equal(h.calls[0].args.networkContext,'main');assert.equal(h.$('refreshAssets').attributes['aria-busy'],'true');
 finish({network:'main',queued:true});await pending;assert.deepEqual(h.toasts,['home.refreshRequested']);assert.equal(h.$('refreshAssets').attributes['aria-busy'],'false');assert.equal(h.timers.size,0);
});
test('a failed or stale balance refresh cannot show an updated confirmation',async()=>{
 for(const stale of [false,true]) {
  const h=ui();let finish;h.context.currentScreen='home';h.context.renderStatus=()=>{};h.context.refreshHome=async()=>true;h.context.call=()=>new Promise(r=>{finish=r;});
  vm.runInContext(between('let assetsRefreshing=false;','// -------------------------------------------------------------- balance'),h.context);
  const pending=h.$('refreshAssets').onclick();if(stale)h.context.secretEpoch++;finish({network:'main',queued:false});await pending;assert(!h.toasts.includes('home.refreshed'));assert.equal(h.$('refreshAssets').disabled,false);
 }
});

test('a never-answering refresh times out, releases the button and permits a retry',async()=>{
 const h=ui(),replies=[];h.context.call=()=>new Promise(r=>replies.push(r));
 vm.runInContext(between('let assetsRefreshing=false;','// -------------------------------------------------------------- balance'),h.context);
 const pending=h.$('refreshAssets').onclick();assert.equal([...h.timers.values()][0].ms,8000);h.expire();await pending;
 assert.equal(h.$('refreshAssets').disabled,false);assert.equal(h.$('refreshAssets').attributes['aria-busy'],'false');assert.deepEqual(h.toasts,['home.refreshTimeout']);
 const retry=h.$('refreshAssets').onclick();replies[0]({network:'main',queued:true});await Promise.resolve();assert.equal(h.$('refreshAssets').disabled,true);
 replies[1]({network:'main',queued:true});await retry;assert.deepEqual(h.toasts,['home.refreshTimeout','home.refreshRequested']);assert.equal(h.timers.size,0);
});
test('navigation or lock releases a hung refresh immediately and ignores its late acknowledgement',async()=>{
 for(const action of ['navigate','lock']) {
  const h=ui();let finish;h.context.call=()=>new Promise(r=>{finish=r;});
  vm.runInContext(between('let assetsRefreshing=false;','// -------------------------------------------------------------- balance'),h.context);
  vm.runInContext(between('function showScreen(', 'function openSheet('),h.context);
  const pending=h.$('refreshAssets').onclick();
  if(action==='navigate')vm.runInContext("showScreen('modes')",h.context);else {h.context.app.unlocked=false;vm.runInContext('cancelAssetRefresh()',h.context);}
  await pending;assert.equal(h.$('refreshAssets').disabled,false);assert.equal(h.timers.size,0);
  finish({network:'main',queued:true});await Promise.resolve();assert.equal(h.toasts.length,0);
 }
});
test('refresh does not wait for an unresponsive Home render and never announces unverified funds',async()=>{
 const h=ui();let homeCalls=0;h.context.refreshHome=()=>{homeCalls++;return new Promise(()=>{});};h.context.call=async()=>({network:'main',queued:true});
 vm.runInContext(between('let assetsRefreshing=false;','// -------------------------------------------------------------- balance'),h.context);
 await h.$('refreshAssets').onclick();assert.equal(homeCalls,0);assert.equal(h.$('refreshAssets').disabled,false);assert.deepEqual(h.toasts,['home.refreshRequested']);
});
test('refresh failures, malformed acknowledgements and changed networks release the button',async()=>{
 for(const scenario of ['reject','malformed','network']) {
  const h=ui();h.context.call=async()=>{if(scenario==='reject')throw Error('worker unavailable');return scenario==='malformed'?{}:{network:'testnet',queued:true};};
  vm.runInContext(between('let assetsRefreshing=false;','// -------------------------------------------------------------- balance'),h.context);
  await h.$('refreshAssets').onclick();assert.equal(h.$('refreshAssets').disabled,false);assert.equal(h.toasts.length,1);assert(!h.toasts.includes('home.refreshRequested'));assert.equal(h.timers.size,0);
 }
});
test('a late Home reply cannot overwrite the newly selected sub-wallet balance',async()=>{
 const h=ui(),replies=[];h.context.currentScreen='home';h.context.currentSheet=null;h.context.addrCache={};h.context.historyCache=[];h.context.contacts=[];
 h.context.call=()=>new Promise(r=>replies.push(r));h.context.renderBalance=async s=>{h.$('balAvail').textContent=s.available;};h.context.renderHistory=async()=>{};h.context.renderAddresses=async()=>{};h.context.renderPrivacy=()=>{};h.context.renderHomeWatch=()=>{};h.context.renderPrivatePanel=()=>{};
 vm.runInContext(between('let homeRequest=0;','/** Actions passed'),h.context);
 const standard=vm.runInContext('refreshHome()',h.context);h.context.app.settings.activeMode='refresh';const refresh=vm.runInContext('refreshHome()',h.context);
 replies[1]({profile:'refresh',height:4,summary:{available:'22'},addresses:{}});assert.equal(await refresh,true);
 replies[0]({profile:'standard',height:4,summary:{available:'99'},addresses:{}});assert.equal(await standard,false);assert.equal(h.$('balAvail').textContent,'22');
});

test('inline removal confirmation keeps a code on Cancel and rejects a stale final removal',async()=>{
 const h=ui();h.context.call=async(cmd,args)=>{h.calls.push({cmd,args});return {list:[{amount:'2',addition_record:'r'}]};};
 await vm.runInContext('renderWaiting()',h.context);const row=h.$('claimWaiting').children[0],button=row.children[1],box=row.children[2],cancel=box.children[1].children[0],remove=box.children[1].children[1];
 await button.onclick();assert.equal(box.hidden,false);assert.equal(h.calls.filter(c=>c.cmd==='claimRemove').length,0);
 await cancel.onclick();assert.equal(box.hidden,true);await remove.onclick();assert.equal(h.calls.filter(c=>c.cmd==='claimRemove').length,0);
 await button.onclick();h.context.secretEpoch++;await remove.onclick();assert.equal(h.calls.filter(c=>c.cmd==='claimRemove').length,0);
});

test('recovery progress names the running method and prevents an accidental restart',()=>{
 const h=ui();h.context.app.status={height:9,tip:40,syncing:true,recoveryMode:'private',recoveryWallet:'standard'};
 vm.runInContext('renderAssetRecovery()',h.context);
 assert.equal(h.$('assetRecover').disabled,true);assert.match(h.$('assetRecoveryStatus').textContent,/assets.private/);
});
test('a failed indexed recovery shows the error and can retry without resetting its checkpoint',async()=>{
 const h=ui();h.context.document.querySelector=()=>({value:'fast'});h.context.app.status={height:9,tip:40,syncing:false,recoveryMode:'fast',recoveryWallet:'standard',fastPending:'fast',error:'node timed out'};
 let retries=0;h.context.refreshAssetsNow=async()=>{retries++;};
 vm.runInContext('renderAssetRecovery()',h.context);assert.equal(h.$('assetRecover').disabled,false);assert.equal(h.$('assetRecoveryStatus').textContent,'node timed out');
 await h.$('assetRecover').onclick();assert.equal(retries,1);assert.equal(h.calls.length,0);
});


test('running Private scan can switch to Fast; another wallet does not inherit its progress',()=>{
 const h=ui();let chosen='private';h.context.document.querySelector=()=>({value:chosen});h.context.app.status={height:9,tip:40,syncing:true,recoveryMode:'private',recoveryWallet:'standard'};
 vm.runInContext('renderAssetRecovery()',h.context);assert.equal(h.$('assetRecover').disabled,true);assert.equal(h.$('assetPause').hidden,false);
 chosen='fast';vm.runInContext('renderAssetRecovery()',h.context);assert.equal(h.$('assetRecover').disabled,false);assert.equal(h.$('assetRecover').textContent,'assets.switch');
 h.context.app.settings.activeMode='refresh';vm.runInContext("assetRecoveryProfile='refresh';renderAssetRecovery()",h.context);
 assert.equal(h.$('assetRecoveryStatus').textContent,'assets.notStarted');assert.equal(h.$('assetRecover').disabled,false);assert.equal(h.$('assetPause').hidden,true);
});
test('stopping and resuming recovery use scoped commands and time out without trapping controls',async()=>{
 const h=ui();h.context.currentScreen='claim';h.context.app.status={height:9,tip:40,syncing:true,recoveryMode:'private',recoveryWallet:'standard'};
 h.context.call=async(cmd,args)=>{h.calls.push({cmd,args});return {status:{...h.context.app.status,scanPaused:cmd==='pauseRecovery'},recoveries:{}};};
 await h.$('assetPause').onclick();assert.equal(h.calls[0].cmd,'pauseRecovery');assert.equal(h.calls[0].args.walletMode,'standard');assert.equal(h.$('assetRecover').textContent,'assets.resume');
 await h.$('assetRecover').onclick();assert.equal(h.calls[1].cmd,'resumeRecovery');
 h.context.call=()=>new Promise(()=>{});const pending=h.$('assetPause').onclick();h.expire();await pending;
 assert.equal(h.$('assetPause').disabled,false);assert.equal(h.$('assetRecoveryError').textContent,'assets.controlTimeout');
});
test('send card hides an old wallet or network payment and clears its click target',()=>{
 const h=ui();h.context.ORDER=['wait','check','build','prove','send','done'];h.context.progressPct=()=>20;
 vm.runInContext(between('function sendBelongsHere(', 'function renderProgress('),h.context);
 vm.runInContext(between('const STEP_LABEL =','// ------------------------------------------------------------- network'),h.context);
 const send={id:'standard-send',walletMode:'standard',network:'main',status:'proving',amount:'1'};
 h.context.send=send;vm.runInContext('renderSendCard(send)',h.context);assert.equal(h.$('sendCard').hidden,false);
 h.context.app.settings.activeMode='refresh';vm.runInContext('renderSendCard(send)',h.context);assert.equal(h.$('sendCard').hidden,true);assert.equal(h.$('sendCard').onclick,null);
 h.context.app.settings.activeMode='standard';h.context.app.settings.network='testnet';vm.runInContext('renderSendCard(send)',h.context);assert.equal(h.$('sendCard').hidden,true);
});
test('normal send progress skips the optional fresh-block step and separates node checking from building',()=>{
 const h=ui();vm.runInContext(between('const STEP_OF =','function sendBelongsHere('),h.context);
 assert.deepEqual(Array.from(vm.runInContext("sendSteps({waitForFreshBlock:false})",h.context)),['check','build','prove','send','done']);
 assert.equal(vm.runInContext("progressPct({status:'checking',waitForFreshBlock:false})",h.context),0);
 assert.equal(vm.runInContext("progressPct({status:'preparing',waitForFreshBlock:false})",h.context),25);
 assert.equal(vm.runInContext("sendSteps({waitForFreshBlock:true})[0]",h.context),'wait');
});
