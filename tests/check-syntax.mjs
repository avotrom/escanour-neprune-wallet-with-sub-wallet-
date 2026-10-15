import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = (dir) => readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []);
for(const file of files('extension')) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0) {console.error(result.stderr);process.exit(1);}
}
const html=readFileSync('extension/popup.html','utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
if(new Set(ids).size!==ids.length) throw Error('Duplicate DOM IDs');
const js=readFileSync('extension/popup.js','utf8');
for(const m of js.matchAll(/\$\('([^']+)'\)/g)) if(!ids.includes(m[1])) throw Error(`Missing DOM element ${m[1]}`);
const manifest=JSON.parse(readFileSync('extension/manifest.json','utf8'));
if(!manifest.permissions.includes('proxy') || manifest.optional_permissions?.includes('proxy')) throw Error('proxy must be required, never optional');
console.log(`Syntax OK: ${files('extension').length} JS files; ${ids.length} unique DOM IDs; popup bindings and proxy manifest checked.`);
