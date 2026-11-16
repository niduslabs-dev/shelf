import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { extensionId } from './crx3.ts';
import { publish, readExtensions, releaseTag, storedVersions, versionCommits } from './publish.ts';
import type { ListedExtension, PublishTarget } from './publish.ts';
import { approvedCrxUrl, updateUrlFor } from './registry.ts';
import type { RegistryLists } from './standing.ts';
import { packCrx3, spki } from './testing/pack-crx3.ts';
import type { Signer } from './testing/pack-crx3.ts';
import { writeZip } from './testing/write-zip.ts';
import { sha256Hex } from './verify-release.ts';

const signer: Signer = { algorithm: 'rsa', ...generateKeyPairSync('rsa', { modulusLength: 2048 }) };
const ID = extensionId(spki(signer.publicKey));
const SOURCE = 'https://github.com/alice/example/releases/download/v1.0/example.crx';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

function crx(
  version: string,
  extra: Record<string, unknown> = {},
  files: { name: string; content: Buffer }[] = [],
): Buffer {
  const manifest = {
    manifest_version: 3,
    name: 'Example',
    version,
    update_url: updateUrlFor(ID),
    ...extra,
  };
  return packCrx3({
    archive: writeZip([{ name: 'manifest.json', content: JSON.stringify(manifest) }, ...files]),
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

const none: RegistryLists = { blocklist: [], delisted: [] };

const NOW = '2026-11-16T12:00:00Z';

function fakeTarget(
  downloads: Record<string, Buffer>,
  existing: Record<string, Buffer> = {},
  tags: string[] = Object.keys(existing),
  history: {
    dates?: Record<string, string>;
    releaseJson?: { sha: string; text: string | undefined }[];
    pulls?: Record<string, number>;
  } = {},
): FakeTarget {
  const created = new Map<string, Buffer>();
  return {
    created,
    releaseDates: async () =>
      new Map(
        [...Object.keys(existing), ...created.keys()].map((tag) => [
          tag,
          history.dates?.[tag] ?? NOW,
        ]),
      ),
    releaseJsonHistory: async () => history.releaseJson ?? [],
    pullForCommit: async (sha) => history.pulls?.[sha],
    releaseTags: async () => tags,
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
    const result = await publish([listed()], none, target);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.stored, [releaseTag(ID, '1.0')]);
    assert.deepEqual(target.created.get(releaseTag(ID, '1.0')), v1);
    assert.equal(result.entries[0]?.manifest.version, '1.0');
  });

  it('leaves an already stored release alone when it matches', async () => {
    const target = fakeTarget({}, { [releaseTag(ID, '1.0')]: v1 });
    const result = await publish([listed()], none, target);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.stored, []);
    assert.equal(result.entries.length, 1);
  });

  it('refuses a source file swapped after review', async () => {
    const target = fakeTarget({ [SOURCE]: crx('1.0', { description: 'swapped' }) });
    const result = await publish([listed()], none, target);
    assert.match(result.problems.join(), /SHA-256/);
    assert.equal(target.created.size, 0);
  });

  it('flags a stored copy that no longer matches release.json', async () => {
    const target = fakeTarget(
      {},
      { [releaseTag(ID, '1.0')]: crx('1.0', { description: 'other' }) },
    );
    assert.match(
      (await publish([listed()], none, target)).problems.join(),
      /stored .crx doesn't match/,
    );
  });

  it('skips blocked extensions entirely', async () => {
    const target = fakeTarget({ [SOURCE]: v1 });
    const result = await publish(
      [listed()],
      { blocklist: [{ id: ID, reason: 'x', date: '2026-11-16' }], delisted: [] },
      target,
    );
    assert.deepEqual(result, { entries: [], stored: [], problems: [], warnings: [] });
  });

  it('stops when a stored ID would lose its update file', async () => {
    const result = await publish(
      [],
      none,
      fakeTarget({}, {}, [releaseTag(ID, '1.0'), 'unrelated-tag']),
    );
    assert.match(result.problems.join(), /would 404/);
  });

  it('accepts an unlisted ID once it is marked removed, or blocked', async () => {
    const tags = [releaseTag(ID, '1.0')];
    const removed: RegistryLists = {
      blocklist: [],
      delisted: [{ id: ID, kind: 'removed', reason: 'x', date: '2026-11-16' }],
    };
    assert.deepEqual((await publish([], removed, fakeTarget({}, {}, tags))).problems, []);
  });

  it('stores a final release that leaves, and keeps it out of the listed state', async () => {
    const away = crx('2.0', { update_url: 'https://example.com/u.xml' });
    const leaving: ListedExtension = {
      ...listed(away),
      release: { version: '2.0', crx: SOURCE, sha256: sha256Hex(away) },
    };
    const lists: RegistryLists = {
      blocklist: [],
      delisted: [{ id: ID, kind: 'left', reason: 'x', date: '2026-11-16' }],
    };
    const result = await publish([leaving], lists, fakeTarget({ [SOURCE]: away }));
    assert.deepEqual(result.problems, []);
    assert.equal(result.entries[0]?.standing, 'left');
  });

  it('needs the folder of an extension that left', async () => {
    const lists: RegistryLists = {
      blocklist: [],
      delisted: [{ id: ID, kind: 'left', reason: 'x', date: '2026-11-16' }],
    };
    assert.match(
      (await publish([], lists, fakeTarget({}))).problems.join(),
      /must keep its final release/,
    );
  });

  it('reports a failed download without throwing', async () => {
    assert.match((await publish([listed()], none, fakeTarget({}))).problems.join(), /HTTP 404/);
  });
});

describe('store page data', () => {
  it('gathers the size, the icon and a one-row trail for a new listing', async () => {
    const withIcon = crx('1.0', { icons: { '128': 'icon.png' } }, [
      { name: 'icon.png', content: PNG },
    ]);
    const result = await publish([listed(withIcon)], none, fakeTarget({ [SOURCE]: withIcon }));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
    const details = result.entries[0]?.details;
    assert.ok(details);
    assert.equal(details.size, withIcon.length);
    assert.deepEqual(details.icon, PNG);
    assert.deepEqual(details.trail, [
      { version: '1.0', date: NOW, change: { text: 'Listed', adds: false } },
    ]);
  });

  it('builds the trail from every stored release, diffing each with the one before', async () => {
    const v2 = crx('2.0', { permissions: ['tabs'] });
    const v3 = crx('3.0', { permissions: ['tabs'] });
    const current: ListedExtension = {
      id: ID,
      listing,
      release: { version: '3.0', crx: SOURCE, sha256: sha256Hex(v3) },
    };
    const target = fakeTarget(
      {},
      { [releaseTag(ID, '1.0')]: v1, [releaseTag(ID, '2.0')]: v2, [releaseTag(ID, '3.0')]: v3 },
      undefined,
      {
        dates: {
          [releaseTag(ID, '1.0')]: '2026-10-10T00:00:00Z',
          [releaseTag(ID, '2.0')]: '2026-11-02T00:00:00Z',
          [releaseTag(ID, '3.0')]: '2026-11-12T00:00:00Z',
        },
        releaseJson: [
          { sha: 'c3', text: JSON.stringify({ version: '3.0' }) },
          { sha: 'c2b', text: JSON.stringify({ version: '2.0', crx: 'fixed' }) },
          { sha: 'c2', text: JSON.stringify({ version: '2.0' }) },
          { sha: 'c1', text: JSON.stringify({ version: '1.0' }) },
        ],
        pulls: { c3: 14, c2: 11 },
      },
    );
    const result = await publish([current], none, target);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.entries[0]?.details.trail, [
      {
        version: '3.0',
        date: '2026-11-12T00:00:00Z',
        change: { text: 'No permission changes', adds: false },
        review: 14,
      },
      {
        version: '2.0',
        date: '2026-11-02T00:00:00Z',
        change: { text: 'Added: tabs', adds: true },
        review: 11,
      },
      { version: '1.0', date: '2026-10-10T00:00:00Z', change: { text: 'Listed', adds: false } },
    ]);
  });

  it('warns, without stopping, when an older release cannot be read', async () => {
    const v2 = crx('2.0');
    const current: ListedExtension = {
      id: ID,
      listing,
      release: { version: '2.0', crx: SOURCE, sha256: sha256Hex(v2) },
    };
    const target = fakeTarget({}, { [releaseTag(ID, '2.0')]: v2 }, undefined);
    const dates = await target.releaseDates();
    target.releaseDates = async () => new Map([...dates, [releaseTag(ID, '1.0'), NOW]]);
    const result = await publish([current], none, target);
    assert.deepEqual(result.problems, []);
    assert.match(result.warnings.join(), /1\.0 manifest: HTTP 404/);
    assert.deepEqual(result.entries[0]?.details.trail[0]?.change, {
      text: 'Permission change unknown',
      adds: false,
    });
  });
});

describe('storedVersions', () => {
  it("lists one ID's stored versions, newest first", () => {
    const other = 'b'.repeat(32);
    assert.deepEqual(
      storedVersions(ID, [`${ID}-1.10`, `${ID}-1.9`, `${other}-5.0`, `${ID}-2.0`, `${ID}-bad`]),
      ['2.0', '1.10', '1.9'],
    );
  });
});

describe('versionCommits', () => {
  it('maps each version to the commit that first set it', () => {
    assert.deepEqual(
      versionCommits([
        { sha: 'c', text: '{"version":"2.0","crx":"x"}' },
        { sha: 'b', text: '{"version":"2.0"}' },
        { sha: 'x', text: 'not json' },
        { sha: 'y', text: undefined },
        { sha: 'a', text: '{"version":"1.0"}' },
      ]),
      new Map([
        ['1.0', 'a'],
        ['2.0', 'b'],
      ]),
    );
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
