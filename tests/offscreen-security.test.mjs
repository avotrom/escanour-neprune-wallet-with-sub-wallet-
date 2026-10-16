import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../extension/offscreen.js',import.meta.url),'utf8');
const submit=source.slice(source.indexOf('async function submit('),source.indexOf('chrome.runtime.onMessage.addListener')).replace('import.meta.url',"'file:///mock/offscreen.js'");
function harness({failure,success=true,prepareFails=false}={}) {
  const values=new Map();let uploads=0;
  const context=vm.createContext({submitting:null,cancelled:new Set(),lightReady:null,Uint8Array,URL,Date,
    importRawKey:async()=>({}),decrypt:async()=>new Uint8Array([1]),initLight:async()=>{},loadSettings:async()=>({}),serversFor:()=>({broadcast:'https://example.invalid/'}),
    light:{submitRequest:()=>{if(prepareFails)throw Error('self-check failed');return 'same transaction';},parseSubmit:()=>success},
    db:{STORES:{sends:'sends',proofs:'proofs',kv:'kv'},get:async(s,k)=>s==='sends'?{prepared:{},jobCount:0}:values.get(k),put:async(s,k,v)=>values.set(k,v)},
    rpc:{id:()=>1,assertRoute:async()=>{},post:async(url,body)=>{uploads++;assert.equal(body,'same transaction');assert.equal(values.get('submit:id').uncertain,true);if(failure)throw failure;return '{}';}},
    report:()=>{},
  });
  vm.runInContext(submit+'\nglobalThis.submit=submit;',context);
  return {run:()=>context.submit('id',new Uint8Array(32)),result:()=>values.get('submit:id'),uploads:()=>uploads};
}
test('broadcast transport failures preserve uncertainty written before the upload',async()=>{
  const h=harness({failure:Error('Failed to fetch')});await h.run();assert.equal(h.uploads(),1);assert.equal(h.result().ok,false);assert.equal(h.result().uncertain,true);
});
test('a definite node rejection or local self-check failure is distinguished from a lost response',async()=>{
  const reject=Error('node: not confirmable');reject.nodeRejected=true;
  for(const options of [{failure:reject},{prepareFails:true}]){const h=harness(options);await h.run();assert.equal(h.result().ok,false);assert.equal(h.result().uncertain,false);}
});
test('a successful broadcast overwrites the crash-recovery uncertainty marker',async()=>{
  const h=harness();await h.run();assert.equal(h.result().ok,true);assert.equal(h.result().uncertain,undefined);
});

test('cancellation during transaction assembly prevents any network upload',async()=>{
  const values=new Map();const cancelled=new Set();let uploads=0;
  const context=vm.createContext({submitting:null,cancelled,lightReady:null,Uint8Array,URL,Date,importRawKey:async()=>({}),decrypt:async()=>new Uint8Array([1]),initLight:async()=>{},loadSettings:async()=>({}),serversFor:()=>({broadcast:'https://example.invalid/'}),light:{submitRequest:()=>'',parseSubmit:()=>true},db:{STORES:{sends:'sends',proofs:'proofs',kv:'kv'},get:async()=>({prepared:{},jobCount:0}),put:async(s,k,v)=>values.set(k,v)},rpc:{id:()=>1,assertRoute:async()=>{cancelled.add('id');},post:async()=>{uploads++;}},report:()=>{}});
  vm.runInContext(submit+'\nglobalThis.submit=submit;',context);await context.submit('id',new Uint8Array(32));assert.equal(uploads,0);assert.equal(values.size,0);
});
