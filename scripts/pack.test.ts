import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { verifyCrx3 } from './crx3.ts';
import { readManifest } from './manifest.ts';
import { PackError, collectFiles, loadSigningKey, packExtension } from './pack.ts';
import { updateUrlFor } from './registry.ts';
import { readEntries } from './zip.ts';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'pem',
  type: 'pkcs8',
});
const key = loadSigningKey(String(pem));
const scratch = mkdtempSync(join(tmpdir(), 'shelf-pack-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let folders = 0;
function folder(files: Record<string, string>): string {
  const root = join(scratch, String(folders++));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifest_version: 3,
    name: 'Test',
    version: '1.2.3',
    update_url: updateUrlFor(key.id),
    ...overrides,
  });
}

describe('packExtension', () => {
  it('makes a .crx the registry accepts, signed for the key', () => {
    const root = folder({
      'manifest.json': manifest(),
      'icons/16.png': 'png',
      'background.js': '',
    });
    const packed = packExtension(root, key);
    const crx = verifyCrx3(packed.crx);
    assert.equal(crx.id, key.id);
    assert.equal(packed.id, key.id);
    assert.equal(packed.version, '1.2.3');
    assert.equal(readManifest(crx.archive).version, '1.2.3');
    assert.deepEqual(
      readEntries(crx.archive).map((entry) => entry.name),
      ['background.js', 'icons/16.png', 'manifest.json'],
    );
  });

  it('gives the same bytes on every run', () => {
    const files = { 'manifest.json': manifest(), 'b.js': 'b', 'a/z.js': 'z', 'a/b.js': 'ab' };
    const first = packExtension(folder(files), key);
    const second = packExtension(folder(files), key);
    assert.deepEqual(first.crx, second.crx);
    assert.equal(first.sha256, second.sha256);
  });

  it('leaves out dotfiles and dot-folders', () => {
    const root = folder({
      'manifest.json': manifest(),
      '.DS_Store': 'x',
      '.git/config': 'x',
      'lib/.env': 'x',
      'lib/main.js': 'x',
    });
    const names = readEntries(verifyCrx3(packExtension(root, key).crx).archive).map((e) => e.name);
    assert.deepEqual(names, ['lib/main.js', 'manifest.json']);
  });

  it('refuses a folder holding a key file', () => {
    for (const name of ['key.pem', 'secrets/signing.KEY']) {
      const root = folder({ 'manifest.json': manifest(), [name]: 'secret' });
      assert.throws(
        () => packExtension(root, key),
        (error: unknown) =>
          error instanceof PackError &&
          error.message.includes(name) &&
          !error.message.includes('secret\n'),
      );
    }
  });

  it('gives the exact update_url to put in when it is wrong', () => {
    const root = folder({ 'manifest.json': manifest({ update_url: 'https://example.com/u.xml' }) });
    assert.throws(
      () => packExtension(root, key),
      (error: unknown) =>
        error instanceof PackError &&
        error.message.includes(
          `Set "update_url" in manifest.json to "https://shelf.niduslabs.dev/updates/${key.id}.xml"`,
        ),
    );
  });

  it('refuses Manifest V2 and a bad version', () => {
    const root = folder({ 'manifest.json': manifest({ manifest_version: 2, version: '1.02' }) });
    assert.throws(
      () => packExtension(root, key),
      (error: unknown) =>
        error instanceof PackError &&
        error.message.includes('"manifest_version" to 3') &&
        error.message.includes('Set "version"'),
    );
  });

  it('refuses a folder without manifest.json', () => {
    assert.throws(() => packExtension(folder({ 'a.js': '' }), key), PackError);
  });
});

describe('loadSigningKey', () => {
  it('refuses a key that is not PEM, without quoting it', () => {
    assert.throws(
      () => loadSigningKey('not-a-key-abc123'),
      (error: unknown) => error instanceof PackError && !error.message.includes('abc123'),
    );
  });

  it('refuses a non-RSA key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    });
    assert.throws(() => loadSigningKey(String(ec)), /must be RSA/);
  });
});

describe('collectFiles', () => {
  it('returns paths with forward slashes', () => {
    const files = collectFiles(folder({ 'a/b/c.js': '' }));
    assert.deepEqual(
      files.map((file) => file.name),
      ['a/b/c.js'],
    );
  });
});
