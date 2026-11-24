import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict';
const en=JSON.parse(readFileSync('packages/frontend-console/src/locales/en.json','utf8')),cs=JSON.parse(readFileSync('packages/frontend-console/src/locales/cs.json','utf8'));
const canonical=d=>[...new Set(Object.keys(d).map(k=>k.replace(/_(one|few|many|other|zero|two)$/, '')))].sort();
assert.deepEqual(canonical(en),canonical(cs));
for(const key of Object.keys(en)) assert.deepEqual([...en[key].matchAll(/{{([^}]+)}}/g)].map(m=>m[1]).sort(),[...cs[key].matchAll(/{{([^}]+)}}/g)].map(m=>m[1]).sort(),key);
for(const data of [en,cs]) for(const key of ['listDisplayMoveUp','listDisplayMoveDown']) assert.equal(typeof data[key],'string');
console.log(`${Object.keys(en).length} EN / ${Object.keys(cs).length} CS keys; ${canonical(en).length} canonical keys and ${Object.keys(en).length} shared interpolation sets: PASS`);
