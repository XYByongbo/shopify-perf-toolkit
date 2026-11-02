import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {parse} from 'acorn';
const lib=new URL('../lib/',import.meta.url);
test('library static imports remain acyclic and collection/state/verification stay separated',async()=>{
  const graph=new Map();
  for(const file of (await readdir(lib)).filter(f=>f.endsWith('.mjs'))) {
    const tree=parse(await readFile(new URL(file,lib),'utf8'),{ecmaVersion:'latest',sourceType:'module'});
    graph.set(file,tree.body.filter(n=>['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(n.type)&&n.source?.value.startsWith('./')).map(n=>n.source.value.slice(2)));
  }
  const done=new Set();
  function visit(file,stack=[]) {
    assert.ok(!stack.includes(file),'Static import cycle: '+[...stack,file].join(' -> '));
    if(done.has(file))return;
    for(const dep of graph.get(file)??[])visit(dep,[...stack,file]);done.add(file);
  }
  for(const file of graph.keys())visit(file);
  for(const dep of ['measure.mjs','scenarios.mjs','optimization-collection.mjs','improvement-session.mjs'])assert.ok(!graph.get('optimization-verification.mjs').includes(dep));
  assert.ok(!graph.get('improvement-state.mjs').includes('improvement-session.mjs'));
  assert.ok(!graph.get('deployment.mjs').includes('runtime-profile.mjs'));
  const collector=await readFile(new URL('optimization-collection.mjs',lib),'utf8');
  assert.doesNotMatch(collector,/\b(?:verifyOptimization|applySitePlan|rollbackSitePlan)\s*\(/);
});
