import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sha256, lineAt, isInside } from '../lib/source-utils.mjs';
import { sha256 as runtimeSha256 } from '../lib/runtime-profile.mjs';
import { digest } from '../lib/evidence-contract.mjs';

test('source fingerprints keep byte semantics and the existing runtime/evidence APIs', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
  assert.equal(sha256(new Uint8Array([97, 98, 99])), sha256('abc'));
  assert.equal(sha256('主题😀'), sha256(Buffer.from('主题😀', 'utf8')));
  assert.equal(runtimeSha256, sha256);
  assert.equal(digest({ text: '主题😀' }), sha256('{"text":"主题😀"}'));
  assert.equal(digest(Buffer.from('abc')), sha256('abc'));
  for (const value of [undefined, null, 42, {}]) assert.throws(() => sha256(value), TypeError);
});

test('source line numbers preserve original UTF-16 offsets and newline boundaries', () => {
  const source = '😀\r\n中\nlast';
  for (const [offset, line] of [[0, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [source.length, 3]]) {
    assert.equal(lineAt(source, offset), line);
  }
  assert.equal(lineAt('', 0), 1);
  assert.equal(lineAt('a\nb\n', 4), 3);
  assert.equal(lineAt('a\rb', 3), 1);
});

test('source containment rejects root, ancestors and sibling-prefix paths', () => {
  const root = path.resolve('theme');
  for (const file of [root, path.dirname(root), path.resolve(root, '../other'), `${root}-copy/file.liquid`]) {
    assert.equal(isInside(root, file), false);
  }
  assert.equal(isInside(root, path.join(root, 'sections/main.liquid')), true);
  assert.equal(isInside(root, path.join(root, '..inside/main.liquid')), true);
  assert.equal(isInside(root, path.resolve(root, 'sections/../../outside.liquid')), false);
});
