import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8');
const between=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert(start>=0&&end>start);return source.slice(start,end);};
function control(){return {value:'',textContent:'',hidden:true,disabled:false,open:false,children:[],dataset:{},style:{},attributes:{},classList:{add(){},remove(){},toggle(){}},append(...els){this.children.push(...els);},setAttribute(k,v){this.attributes[k]=v;},focus(){}};}
function ui(){
 const controls=new Map(),calls=[],toasts=[];const $=id=>{if(!controls.has(id))controls.set(id,control());return controls.get(id);};
 const context=vm.createContext({$,app:{unlocked:true,settings:{activeMode:'standard',network:'main'},status:{}},currentScreen:'payment-codes',secretEpoch:1,SCREENS:[],activeMode:s=>s.activeMode||'standard',
 document:{querySelectorAll:()=>[],createElement:()=>control()},busy:(b,v)=>{b.disabled=v;},err:(id,e)=>{$(id).textContent=e?String(e.message||e):'';},t:key=>key,fmtAmt:x=>x,fmtNum:x=>x,lang:()=> 'en',kindLabel:x=>x,claimErr:e=>String(e.message||e),toast:x=>toasts.push(x),confirm:()=>true,privateRecoveryStart:h=>Math.max(0,Number(h)-1),
 call:async(cmd,args)=>{calls.push({cmd,args});return {list:[],archive:null};},showScreen:name=>{context.currentScreen=name;context.secretEpoch++;},isLocalUrl:()=>false,
 });
 vm.runInContext(between('let claimShown = null,','// -------------------------------------------------------- local archive'),context);
 return {context,$,calls,toasts};
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
 const pending=h.$('refreshAssets').onclick();await h.$('refreshAssets').onclick();assert.equal(h.calls.length,1);assert.equal(h.calls[0].cmd,'sync');assert.equal(h.$('refreshAssets').attributes['aria-busy'],'true');
 finish({height:4,tip:4,syncing:false});await pending;assert.deepEqual(h.toasts,['home.refreshed']);assert.equal(h.$('refreshAssets').attributes['aria-busy'],'false');
});
test('a failed or stale balance refresh cannot show an updated confirmation',async()=>{
 for(const stale of [false,true]) {
  const h=ui();let finish;h.context.currentScreen='home';h.context.renderStatus=()=>{};h.context.refreshHome=async()=>true;h.context.call=()=>new Promise(r=>{finish=r;});
  vm.runInContext(between('let assetsRefreshing=false;','// -------------------------------------------------------------- balance'),h.context);
  const pending=h.$('refreshAssets').onclick();if(stale)h.context.secretEpoch++;finish({serverOk:false,error:'node unavailable'});await pending;assert(!h.toasts.includes('home.refreshed'));
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
 const h=ui();h.context.app.status={height:9,tip:40,syncing:true,recoveryMode:'private'};
 vm.runInContext('renderAssetRecovery()',h.context);
 assert.equal(h.$('assetRecover').disabled,true);assert.match(h.$('assetRecoveryStatus').textContent,/assets.private/);
});
