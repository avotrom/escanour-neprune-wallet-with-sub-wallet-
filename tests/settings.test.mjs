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
test('fresh-block waiting is off for new wallets and older forced defaults, while explicit choices persist',async()=>{
 for(const old of [{},{waitForFreshBlock:true},{waitForFreshBlock:false}])assert.equal((await settings(old).load()).waitForFreshBlock,false);
 const api=settings();await api.save({waitForFreshBlock:true,sendTimingConfigured:true});assert.equal((await api.load()).waitForFreshBlock,true);
 await api.save({waitForFreshBlock:false,sendTimingConfigured:true});assert.equal((await api.load()).waitForFreshBlock,false);
});
test('concurrent settings writes preserve independent sub-wallet recovery choices',async()=>{
 const api=settings();await Promise.all([api.save({recoveryModes:{standard:'node'}}),api.save({recoveryModes:{refresh:'fast'}}),api.save({waitForFreshBlock:true,sendTimingConfigured:true})]);
 const saved=await api.load();assert.equal(saved.recoveryModes.standard,'node');assert.equal(saved.recoveryModes.refresh,'fast');assert.equal(saved.recoveryModes.encrypted,'private');assert.equal(saved.waitForFreshBlock,true);
});
