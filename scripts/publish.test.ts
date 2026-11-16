import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { extensionId } from './crx3.ts';
import { publish, readExtensions, releaseTag } from './publish.ts';
import type { ListedExtension, PublishTarget } from './publish.ts';
import { approvedCrxUrl, updateUrlFor } from './registry.ts';
import { packCrx3, spki } from './testing/pack-crx3.ts';
import type { Signer } from './testing/pack-crx3.ts';
import { writeZip } from './testing/write-zip.ts';
import { sha256Hex } from './verify-release.ts';

const signer: Signer = { algorithm: 'rsa', ...generateKeyPairSync('rsa', { modulusLength: 2048 }) };
const ID = extensionId(spki(signer.publicKey));
const SOURCE = 'https://github.com/alice/example/releases/download/v1.0/example.crx';

function crx(version: string, extra: Record<string, unknown> = {}): Buffer {
  const manifest = {
    manifest_version: 3,
    name: 'Example',
    version,
    update_url: updateUrlFor(ID),
    ...extra,
  };
  return packCrx3({
    archive: writeZip([{ name: 'manifest.json', content: JSON.stringify(manifest) }]),
    signers: [signer],
  });
}

const v1 = crx('1.0');
const listing = {
  name: 'Example',
  summary: 'Does a thing.',
  author: 'alice',
  repo: 'https://github.com/alice/example',
};
const listed = (file = v1): ListedExtension => ({
  id: ID,
  listing,
  release: { version: '1.0', crx: SOURCE, sha256: sha256Hex(file) },
});

interface FakeTarget extends PublishTarget {
  created: Map<string, Buffer>;
}

function fakeTarget(
  downloads: Record<string, Buffer>,
  existing: Record<string, Buffer> = {},
): FakeTarget {
  const created = new Map<string, Buffer>();
  return {
    created,
    hasRelease: async (tag) => tag in existing || created.has(tag),
    download: async (url) => {
      const stored = Object.entries(existing).find(
        ([tag]) => approvedCrxUrl(ID, tag.slice(ID.length + 1)) === url,
      );
      const file = stored?.[1] ?? downloads[url];
      if (!file) throw new Error('HTTP 404');
      return file;
    },
    createRelease: async (tag, _name, _body, bytes) => {
      created.set(tag, bytes);
    },
  };
}

describe('publish', () => {
  it('stores a new approved release after verifying it', async () => {
    const target = fakeTarget({ [SOURCE]: v1 });
    const result = await publish([listed()], [], target);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.stored, [releaseTag(ID, '1.0')]);
    assert.deepEqual(target.created.get(releaseTag(ID, '1.0')), v1);
    assert.equal(result.entries[0]?.manifest.version, '1.0');
  });

  it('leaves an already stored release alone when it matches', async () => {
    const target = fakeTarget({}, { [releaseTag(ID, '1.0')]: v1 });
    const result = await publish([listed()], [], target);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.stored, []);
    assert.equal(result.entries.length, 1);
  });

  it('refuses a source file swapped after review', async () => {
    const target = fakeTarget({ [SOURCE]: crx('1.0', { description: 'swapped' }) });
    const result = await publish([listed()], [], target);
    assert.match(result.problems.join(), /SHA-256/);
    assert.equal(target.created.size, 0);
  });

  it('flags a stored copy that no longer matches release.json', async () => {
    const target = fakeTarget(
      {},
      { [releaseTag(ID, '1.0')]: crx('1.0', { description: 'other' }) },
    );
    assert.match(
      (await publish([listed()], [], target)).problems.join(),
      /stored .crx doesn't match/,
    );
  });

  it('skips blocked extensions entirely', async () => {
    const target = fakeTarget({ [SOURCE]: v1 });
    const result = await publish([listed()], [{ id: ID, reason: 'x', date: '2026-11-16' }], target);
    assert.deepEqual(result, { entries: [], stored: [], problems: [] });
  });

  it('reports a failed download without throwing', async () => {
    assert.match((await publish([listed()], [], fakeTarget({}))).problems.join(), /HTTP 404/);
  });
});

describe('readExtensions', () => {
  it('reads every listing folder and refuses a malformed one', () => {
    const root = mkdtempSync(join(tmpdir(), 'shelf-'));
    try {
      assert.deepEqual(readExtensions(root), []);
      const folder = join(root, 'extensions', ID);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'listing.json'), JSON.stringify(listing));
      writeFileSync(join(folder, 'release.json'), JSON.stringify(listed().release));
      assert.deepEqual(readExtensions(root), [listed()]);
      mkdirSync(join(root, 'extensions', 'not-an-id'));
      assert.throws(() => readExtensions(root), /not an extension ID/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
