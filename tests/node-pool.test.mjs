import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const raw=fs.readFileSync(new URL('../extension/lib/rpc.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const request=JSON.stringify({jsonrpc:'2.0',method:'chain_height',params:[],id:1});
const a='https://node-a.invalid/',b='https://node-b.invalid/';
function harness(initial=0,session={}) {
 const settings={network:'main',tor:false,servers:{main:{sync:a,fallback:b,randomFallback:true}}},calls=[];let randoms=0;
 const ctx=vm.createContext({URL,Uint8Array,AbortController,setTimeout,clearTimeout,TypeError,
  crypto:{getRandomValues:bytes=>{randoms++;bytes[0]=initial;return bytes;}},
  chrome:{storage:{session:{get:async key=>({[key]:structuredClone(session[key])}),set:async patch=>Object.assign(session,structuredClone(patch))}}},
  loadSettings:async()=>structuredClone(settings),fetch:async(url,options)=>{calls.push({url,options});return ctx.respond(url,options);},
 });
 ctx.respond=async()=>({ok:true,text:async()=>'{"result":{"height":100}}'});
 vm.runInContext(raw+'\nglobalThis.api={read,post,nodeSession,resetNodeSession};',ctx);
 return {api:ctx.api,settings,session,calls,ctx,randoms:()=>randoms};
}
for(const chosen of [0,1])test(`node ${chosen?'B':'A'} is chosen randomly once and held for concurrent session reads`,async()=>{
 const h=harness(chosen);await Promise.all([h.api.read(a,request),h.api.read(a,request),h.api.read(a,request)]);
 assert.equal(h.randoms(),1);assert(h.calls.every(c=>c.url===(chosen?b:a)));
 const restarted=harness(1-chosen,h.session);await restarted.api.read(a,request);assert.equal(restarted.randoms(),0);assert.equal(restarted.calls[0].url,chosen?b:a);
});
test('transport failure switches once and subsequent reads stay on the successful fallback',async()=>{
 const h=harness();h.ctx.respond=async url=>{if(url===a)throw TypeError('Failed to fetch');return {ok:true,text:async()=>'{"result":1}'};};
 await h.api.read(a,request);await h.api.read(a,request);assert.deepEqual(h.calls.map(c=>c.url),[a,b,b]);
});
test('both failed nodes are attempted at most once per read',async()=>{
 const h=harness();h.ctx.respond=async()=>{throw TypeError('Failed to fetch');};await assert.rejects(h.api.read(a,request),/fetch/);assert.equal(h.calls.length,2);
});
test('cancellation, node rejection and Tor failure cannot trigger fallback or bypass routing',async()=>{
 for(const reason of ['SCAN_INTERRUPTED','rejected','tor']) {
  const h=harness();if(reason==='tor'){h.settings.tor=true;h.session.tor={required:true,state:'off'};}
  h.ctx.respond=async()=>{const e=Error(reason);if(reason==='rejected')e.nodeRejected=true;throw e;};
  await assert.rejects(h.api.read(a,request));assert.equal(h.calls.length,reason==='tor'?0:1);assert.equal((await h.api.nodeSession(h.settings)).label,'A');
 }
});
test('HTTP server failures and malformed JSON can fail over; HTTP client errors cannot',async()=>{
 for(const scenario of ['server','json','client']) {
  const h=harness();h.ctx.respond=async url=>url===b?{ok:true,text:async()=>'{"result":1}'}:scenario==='json'?{ok:true,text:async()=>'bad json'}:{ok:false,status:scenario==='server'?503:403,text:async()=>''};
  if(scenario==='client'){await assert.rejects(h.api.read(a,request),/403/);assert.equal(h.calls.length,1);}else{await h.api.read(a,request);assert.equal(h.calls[1].url,b);}
 }
});
test('uploads and explicit endpoint tests use direct POST without automatic replay',async()=>{
 const h=harness();h.ctx.respond=async()=>{throw TypeError('Failed to fetch');};
 await assert.rejects(h.api.post(a,'{"method":"wallet_submitTransaction"}'));assert.equal(h.calls.length,1);
 await assert.rejects(h.api.read(a,'{"method":"wallet_submitTransaction"}'));assert.equal(h.calls.length,2);
});
test('disabled fallback and unconfigured endpoints never use the secondary',async()=>{
 const h=harness(1);h.settings.servers.main.randomFallback=false;await h.api.read(a,request);assert.equal(h.calls[0].url,a);
 h.settings.servers.main.randomFallback=true;await h.api.read('https://other.invalid/',request);assert.equal(h.calls[1].url,'https://other.invalid/');
});
test('an in-flight failure cannot contact a fallback removed by new settings',async()=>{
 const h=harness();h.ctx.respond=async()=>{h.settings.servers.main.randomFallback=false;throw TypeError('Failed to fetch');};
 await assert.rejects(h.api.read(a,request));assert.equal(h.calls.length,1);
});
test('concurrent failures of the old node do not switch a healthy fallback back again',async()=>{
 const h=harness(),rejects=[];h.ctx.respond=url=>url===a?new Promise((_,reject)=>rejects.push(reject)):Promise.resolve({ok:true,text:async()=>'{"result":1}'});
 const first=h.api.read(a,request),second=h.api.read(a,request);
 while(rejects.length<2)await new Promise(resolve=>setImmediate(resolve));
 rejects[0](TypeError('Failed to fetch'));await first;rejects[1](TypeError('Failed to fetch'));await second;
 assert.equal((await h.api.nodeSession(h.settings)).label,'B');assert.equal(h.randoms(),1);
});
