import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {associateScript, createSourceIndexSession, indexThemeSources, sourceIndexForSnapshot} from '../lib/source-attribution.mjs';
import {sourceSnapshot} from '../lib/theme-source.mjs';

async function fixture(t, files) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'perfkit-index-reuse-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [file, contents] of Object.entries(files)) {
    const filename = path.join(root, file);
    await mkdir(path.dirname(filename), {recursive: true});
    await writeFile(filename, contents);
  }
  return root;
}

test('index uses the verified snapshot read for both JS graph and mapping without rereading bodies', async t => {
  const root = await fixture(t, {
    'assets/main.js': "import './dependency.js';\nconsole.log('fixture');",
    'assets/dependency.js': 'export const value = 1;',
  });
  const file = path.join(root, 'assets/main.js');
  let snapshotReads = 0, extraReads = 0;
  const {open, readFile} = fs.promises;
  const openMock = t.mock.method(fs.promises, 'open', async (name, ...args) => {
    if (name === file) snapshotReads++;
    return open(name, ...args);
  });
  const readMock = t.mock.method(fs.promises, 'readFile', async (name, ...args) => {
    if (name === file) extraReads++;
    return readFile(name, ...args);
  });
  syncBuiltinESMExports();
  let index;
  try { index = await indexThemeSources(root); }
  finally {
    openMock.mock.restore();
    readMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(snapshotReads, 2, 'initial and final independent fingerprints');
  assert.equal(extraReads, 0, 'parser input came from the initial fingerprint read');
  assert.ok(index.edges.some(edge => edge.from === 'assets/main.js' && edge.to === 'assets/dependency.js' && edge.kind === 'js-import'));
  const association = associateScript("import './dependency.js';console.log( 'fixture' );", index);
  assert.equal(association.file, 'assets/main.js');
  assert.equal(association.status, 'verified-ast');
});

test('independent end fingerprint rejects a changed body even when byte length is unchanged', async t => {
  const root = await fixture(t, {'assets/main.js': 'let count = 1;'});
  const file = path.join(root, 'assets/main.js');
  const open = fs.promises.open;
  let reads = 0;
  const mock = t.mock.method(fs.promises, 'open', async (name, ...args) => {
    if (name === file && ++reads === 2) await writeFile(file, 'let count = 2;');
    return open(name, ...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(indexThemeSources(root), /Source drift during indexing/); }
  finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('index retrieval is scoped by project and hash and cannot be poisoned through returned objects', async t => {
  const root = await fixture(t, {'assets/style.css': '.fixture{color:red}'});
  const other = await fixture(t, {'assets/style.css': '.fixture{color:red}'});
  const session = createSourceIndexSession();
  const index = await indexThemeSources(root, {session});
  index.files[0].text = '.fixture{color:blue}';
  index.cssUnits[0].rules[0].nodes[0].value = 'blue';
  const current = await sourceSnapshot(root);
  const reused = sourceIndexForSnapshot(session, current);
  assert.equal(reused.files[0].text, '.fixture{color:red}');
  assert.equal(reused.cssUnits[0].rules[0].nodes[0].value, 'red');
  assert.equal(sourceIndexForSnapshot(session, await sourceSnapshot(other)), null);
  assert.equal(sourceIndexForSnapshot(session, {...current, complete: false}), null);
  await writeFile(path.join(root, 'assets/style.css'), '.fixture{color:tan}');
  assert.equal(sourceIndexForSnapshot(session, await sourceSnapshot(root)), null);
});

test('raw snapshot still fingerprints invalid UTF-8 but it cannot become text index evidence', async t => {
  const root = await fixture(t, {'assets/main.js': Buffer.from([0xff, 0xfe])});
  assert.equal((await sourceSnapshot(root)).complete, true);
  await assert.rejects(indexThemeSources(root), /Source changed while indexing/);
});
