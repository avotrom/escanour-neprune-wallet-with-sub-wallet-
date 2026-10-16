import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { contactAddresses, decorateWatch, visibleWatch, activeWatchIds, scanProgress, singleFlight } from '../extension/lib/watch-model.js';
import * as rpc from '../extension/lib/rpc.js';

test('legacy contacts and paired contacts retain independent address choices', () => {
  assert.deepEqual(contactAddresses({ address:'a', kind:'generation' }), [{address:'a',kind:'generation'}]);
  const pair = [{address:'a',kind:'generation'}, {address:'b',kind:'ec-hybrid'}];
  assert.equal(contactAddresses({address:'a',addresses:pair}), pair);
});
test('hidden assets remain followed; paused addresses alone are excluded from scanning', () => {
  const rows = decorateWatch([{id:1,label:'Atlas',kind:'generation'},{id:2,label:'Atlas',kind:'ec-hybrid'},{id:3,label:'Other'}], {1:{hidden:true},2:{paused:true}});
  assert.deepEqual(visibleWatch(rows).map(a=>a.id),[2,3]);
  assert.deepEqual(visibleWatch(rows,true,'atlas').map(a=>a.id),[1,2]);
  assert.deepEqual(activeWatchIds(rows, {2:{paused:true}}),[1,3]);
  assert.equal(rows.length,3);
});
test('cursor progress respects custom start heights, future starts and overrun bounds', () => {
  assert.equal(scanProgress({from_height:501,scanned_to:750},1000).percent,50);
  assert.equal(scanProgress({from_height:1001,scanned_to:1000},999).percent,100);
  assert.equal(scanProgress({from_height:1,scanned_to:1200},1000).percent,100);
});
test('concurrent sync or refresh calls share a run, then a later call starts a new run', async () => {
  let resolve, count=0;
  const run=singleFlight(()=>{count++;return new Promise(r=>{resolve=r;});});
  const first=run(); const second=run();
  assert.equal(first,second); await Promise.resolve(); resolve(7);
  assert.equal(await second,7); assert.equal(count,1);
  const third=run(); await Promise.resolve(); resolve(8); assert.equal(await third,8); assert.equal(count,2);
});
test('a user action aborts only background RPC requests', async () => {
  const original=globalThis.fetch;
  const requests=[];
  globalThis.fetch=(url,{signal})=>new Promise((resolve,reject)=>{
    requests.push({signal,resolve}); signal.addEventListener('abort',()=>reject(signal.reason));
  });
  try {
    const scan=rpc.post('https://example.invalid/','{}',{interruptible:true});
    const manual=rpc.post('https://example.invalid/','{}');
    await Promise.resolve();
    rpc.interrupt();
    await assert.rejects(scan,/SCAN_INTERRUPTED/);
    assert.equal(requests[1].signal.aborted,false);
    requests[1].resolve({ok:true,text:async()=>'{"result":1}'});
    assert.equal(await manual,'{"result":1}');
  } finally { globalThis.fetch=original; }
});
test('custom node URLs enforce the existing HTTPS / local HTTP policy',()=>{
  assert.equal(rpc.normalizeServer('http://127.0.0.1:9799'),'http://127.0.0.1:9799/');
  assert.throws(()=>rpc.normalizeServer('http://example.com'),/https/);
});

test('remote requests fail closed while Tor is disconnected; local nodes remain reachable',async()=>{
  globalThis.chrome={storage:{session:{get:async()=>({tor:{required:true,state:'error'}})}}};
  try {
    await assert.rejects(rpc.assertRoute('https://example.invalid/'),/Tor is not connected/);
    await rpc.assertRoute('http://127.0.0.1:9799/');
  } finally { delete globalThis.chrome; }
});

test('node requests cannot follow redirects to an unchosen host',async()=>{
  const original=globalThis.fetch;let options;
  globalThis.fetch=async(url,opts)=>{options=opts;return {ok:true,text:async()=>'{"result":true}'};};
  try{await rpc.post('https://example.invalid/','{}');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');}
  finally{globalThis.fetch=original;}
});
test('node URL validation rejects non-HTTP schemes and embedded credentials',()=>{
  for(const url of ['file://localhost/test','javascript://localhost/test','ws://localhost:9797','https://user:password@example.invalid/'])assert.throws(()=>rpc.normalizeServer(url));
});

test('saved Tor policy cannot be bypassed by a stale session saying Tor is optional',async()=>{
  const source=fs.readFileSync(new URL('../extension/lib/rpc.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nglobalThis.assertRoute=assertRoute;';
  const context=vm.createContext({URL,loadSettings:async()=>({tor:true}),chrome:{storage:{session:{get:async()=>({tor:{required:false,state:'off'}})}}}});
  vm.runInContext(source,context);
  await assert.rejects(context.assertRoute('https://example.invalid/'),/Tor is not connected/);
  await context.assertRoute('http://127.0.0.1:9797/');
});
