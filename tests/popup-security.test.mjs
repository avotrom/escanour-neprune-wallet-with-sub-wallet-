import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8');
const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));

test('missing replies cannot automatically replay Send, rescan or wallet replacement',async()=>{
  for(const cmd of ['send','rescan','create','reset','exportRecovery']) {
    let calls=0;
    const context=vm.createContext({chrome:{runtime:{sendMessage:async()=>{calls++;return undefined;}}},t:x=>x,setTimeout:fn=>fn()});
    vm.runInContext(between('const RETRY_SAFE =','// ------------------------------------------------------------- helpers')+'\nglobalThis.callApi=call;',context);
    await assert.rejects(context.callApi(cmd,{}),/err.actionUnknown/);assert.equal(calls,1);
  }
});
test('read-only wallet status can still retry a missing reply',async()=>{
  let calls=0;
  const context=vm.createContext({chrome:{runtime:{sendMessage:async()=>++calls===1?undefined:{ok:true,data:42}}},t:x=>x,setTimeout:fn=>fn()});
  vm.runInContext(between('const RETRY_SAFE =','// ------------------------------------------------------------- helpers')+'\nglobalThis.callApi=call;',context);
  assert.equal(await context.callApi('state'),42);assert.equal(calls,2);
});

function uiContext(screen) {
  let resolve,downloads=0,renders=0;
  const controls=new Map();
  const $=id=>{if(!controls.has(id))controls.set(id,{value:'test-password',textContent:'',hidden:false,append(){renders++;}});return controls.get(id);};
  const context=vm.createContext({$,secretEpoch:1,currentScreen:screen,app:{unlocked:true,settings:{activeMode:'encrypted'}},activeMode:s=>s.activeMode,call:()=>new Promise(r=>{resolve=r;}),saveText:()=>{downloads++;},wordsInto:()=>{renders++;},vkBlock:()=>({}),kindLabel:x=>x,t:x=>x,busy:()=>{},err:()=>{},revealed:''});
  return {context,$,finish:value=>resolve(value),counts:()=>({downloads,renders})};
}
test('a recovery-file export finishing after lock or navigation cannot download',async()=>{
  for(const changed of ['lock','navigate']) {
    const h=uiContext('private-backup');vm.runInContext(between("$('recoveryExportForm').onsubmit", "$('setKind').onchange"),h.context);
    const pending=h.$('recoveryExportForm').onsubmit({preventDefault(){}});
    h.context.secretEpoch++;if(changed==='lock')h.context.app.unlocked=false;else h.context.currentScreen='home';
    h.finish('mock encrypted backup');await pending;assert.equal(h.counts().downloads,0);assert.equal(h.$('recoveryExportPassword').value,'');
  }
});
test('an unchanged Encrypted export still downloads once',async()=>{
  const h=uiContext('private-backup');vm.runInContext(between("$('recoveryExportForm').onsubmit", "$('setKind').onchange"),h.context);
  const pending=h.$('recoveryExportForm').onsubmit({preventDefault(){}});h.finish('mock encrypted backup');await pending;assert.equal(h.counts().downloads,1);
});
test('late phrase and viewing-key replies cannot repopulate locked screens',async()=>{
  for(const [screen,start,end,form] of [
    ['phrase',"$('revealForm').onsubmit","$('copyPhrase').onclick",'revealForm'],
    ['watch',"$('vkForm').onsubmit",'function vkBlock','vkForm'],
  ]) {
    const h=uiContext(screen);vm.runInContext(between(start,end),h.context);
    const pending=h.$(form).onsubmit({preventDefault(){}});h.context.secretEpoch++;h.context.app.unlocked=false;
    h.finish(screen==='phrase'?'mock phrase':{generation:{},ec_hybrid:{}});await pending;
    assert.equal(h.counts().renders,0);assert.equal(h.context.revealed,'');
  }
});
