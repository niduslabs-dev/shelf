import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { approvedCrxUrl } from './registry.ts';
import { buildSite, updateXml } from './site.ts';
import type { IndexEntry, SiteEntry } from './site.ts';

const ID = 'a'.repeat(32);
const BLOCKED = 'b'.repeat(32);
const LEFT = 'c'.repeat(32);
const REMOVED = 'd'.repeat(32);
const entry = (id: string, standing: SiteEntry['standing'] = 'listed'): SiteEntry => ({
  id,
  standing,
  listing: {
    name: 'Example',
    summary: 'Does a thing.',
    author: 'alice',
    repo: 'https://github.com/alice/example',
  },
  release: {
    version: '1.2',
    crx: 'https://github.com/alice/example/releases/download/v1.2/e.crx',
    sha256: 'f'.repeat(64),
  },
  manifest: { permissions: ['storage'] },
});

describe('updateXml', () => {
  it('points the update at the stored copy, with its hash', () => {
    const xml = updateXml(ID, { version: '1.2', sha256: 'f'.repeat(64) });
    assert.match(xml, new RegExp(`<app appid='${ID}'>`));
    assert.match(
      xml,
      new RegExp(`codebase='${approvedCrxUrl(ID, '1.2')}' version='1.2' hash_sha256='f{64}'`),
    );
  });

  it('escapes attribute values', () => {
    assert.match(updateXml(ID, { version: `1'<&`, sha256: 'x' }), /version='1&apos;&lt;&amp;'/);
  });

  it('answers "no update" for a blocked extension', () => {
    assert.match(updateXml(ID, 'noupdate'), /<updatecheck status='noupdate' \/>/);
  });
});

describe('buildSite', () => {
  const files = buildSite([entry(ID), entry(BLOCKED), entry(LEFT, 'left')], {
    blocklist: [{ id: BLOCKED, reason: 'Malware', date: '2026-11-16' }],
    delisted: [
      { id: LEFT, kind: 'left', reason: 'Moved', date: '2026-11-16' },
      { id: REMOVED, kind: 'removed', reason: 'Asked', date: '2026-11-16' },
    ],
  });

  it('writes an update file for every listed and blocked extension', () => {
    assert.match(files.get(`updates/${ID}.xml`) ?? '', /version='1\.2'/);
    assert.match(files.get(`updates/${BLOCKED}.xml`) ?? '', /noupdate/);
  });

  it('keeps serving the final release of one that left, outside the index, and silences removed ones', () => {
    assert.match(files.get(`updates/${LEFT}.xml`) ?? '', /version='1\.2'/);
    assert.match(files.get(`updates/${REMOVED}.xml`) ?? '', /noupdate/);
  });

  it('keeps blocked extensions out of index.json and lists them in blocked.json', () => {
    const index = JSON.parse(files.get('index.json') ?? '') as IndexEntry[];
    assert.deepEqual(
      index.map((item) => item.id),
      [ID],
    );
    const [first] = index;
    assert.ok(first);
    assert.deepEqual(first.permissions.permissions, ['storage']);
    assert.equal(first.crx, approvedCrxUrl(ID, '1.2'));
    assert.match(files.get('blocked.json') ?? '', /Malware/);
  });

  it('caches update files for five minutes at most', () => {
    assert.match(
      files.get('_headers') ?? '',
      /\/updates\/\*\n  Content-Type: application\/xml; charset=utf-8\n  Cache-Control: public, max-age=300/,
    );
  });

  it('has a page at the root', () => {
    assert.match(files.get('index.html') ?? '', /<title>Shelf<\/title>/);
  });
});
