import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function settings(stored={}) {
 let record=structuredClone(stored);
 const db={STORES:{kv:'kv'},get:async()=>structuredClone(record),put:async(_,__,value)=>{await Promise.resolve();record=structuredClone(value);}};
 const source=fs.readFileSync(new URL('../extension/lib/settings.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','');
 const context=vm.createContext({db});vm.runInContext(source+'\nglobalThis.api={load,save};',context);return context.api;
}
test('0.25 migration: fresh-block waiting off, exact privacy on, the old succinct switch becomes Full node mode',async()=>{
 for(const old of [{},{waitForFreshBlock:true,sendTimingConfigured:true},{exactPrivacy:false}]){const s=await settings(old).load();assert.equal(s.waitForFreshBlock,false);assert.equal(s.exactPrivacy,true);assert.equal('sendTimingConfigured' in s,false);}
 assert.equal((await settings({}).load()).localArchive,false);
 const fromSuccinct=await settings({succinct:true}).load();assert.equal(fromSuccinct.localArchive,true);assert.equal('succinct' in fromSuccinct,false);
 assert.equal((await settings({localArchive:true}).load()).localArchive,true);
});
test('concurrent settings writes preserve independent sub-wallet recovery choices',async()=>{
 const api=settings();await Promise.all([api.save({recoveryModes:{standard:'node'}}),api.save({recoveryModes:{refresh:'fast'}}),api.save({theme:'dark'})]);
 const saved=await api.load();assert.equal(saved.recoveryModes.standard,'node');assert.equal(saved.recoveryModes.refresh,'fast');assert.equal(saved.recoveryModes.encrypted,'private');assert.equal(saved.theme,'dark');
});
