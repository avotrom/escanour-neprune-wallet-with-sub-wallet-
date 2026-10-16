import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8');
const start=source.indexOf("$('setSave').onclick ="),end=source.indexOf("$('testServer').onclick",start);
function ui() {
 const controls=new Map(),calls=[],$=id=>{if(!controls.has(id))controls.set(id,{value:'',checked:false,textContent:'',disabled:false});return controls.get(id);};
 $('setSync').value='https://a.invalid/';$('setNodeB').value='https://b.invalid/';$('setNodePool').checked=true;
 const context=vm.createContext({$,URL,Set,serversNet:'main',secretEpoch:1,currentScreen:'servers',app:{settings:{network:'main'}},t:x=>x,busy:(b,v)=>{b.disabled=v;},chrome:{permissions:{request:async()=>true}},call:async(cmd,args)=>{calls.push({cmd,args});return cmd==='nodeSession'?{url:'https://b.invalid/',label:'B'}:{network:'main',servers:args.servers};}});
 vm.runInContext(source.slice(start,end),context);return {context,$,calls};
}
test('server option saves both nodes, asks for both hosts and shows the selected peer',async()=>{
 const h=ui();let origins;h.context.chrome.permissions.request=async p=>{origins=Array.from(p.origins);return true;};await h.$('setSave').onclick();
 assert.deepEqual(origins,['https://a.invalid/*','https://b.invalid/*']);const saved=h.calls.find(c=>c.cmd==='saveSettings').args.servers.main;
 assert.equal(saved.fallback,'https://b.invalid/');assert.equal(saved.randomFallback,true);assert.equal(h.$('setMsg').textContent,'srv.saved');assert.equal(h.$('setSave').disabled,false);
});
test('server rejection or denied permission cannot display Saved',async()=>{
 for(const deny of [false,true]) {
  const h=ui();if(deny)h.context.chrome.permissions.request=async()=>false;else h.context.call=async()=>{throw Error('invalid node');};
  await h.$('setSave').onclick();assert.notEqual(h.$('setMsg').textContent,'srv.saved');assert.equal(h.$('setSave').disabled,false);if(deny)assert.equal(h.calls.length,0);
 }
});
test('changing server network during host permission cannot save URLs to the new network',async()=>{
 const h=ui();let grant;h.context.chrome.permissions.request=()=>new Promise(r=>{grant=r;});const pending=h.$('setSave').onclick();h.context.serversNet='testnet';grant(true);await pending;assert.equal(h.calls.length,0);assert.equal(h.$('setSave').disabled,false);
});
test('enabling the node pool with identical or missing URLs is rejected before permission',async()=>{
 for(const address of ['', 'https://a.invalid/']) {
  const h=ui();h.$('setNodeB').value=address;let asked=false;h.context.chrome.permissions.request=async()=>{asked=true;return true;};await h.$('setSave').onclick();assert.equal(asked,false);assert.equal(h.$('setMsg').textContent,'srv.poolNeedTwo');
 }
});
