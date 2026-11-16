import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseClaim, parseListing, parseRelease, parseRepoUrl } from './schema.ts';

const repo = { owner: 'alice', name: 'example' };
const releaseWith = (crx: string) => parseRelease(JSON.stringify({ version: '1.0', crx }), repo);

describe('parseRelease', () => {
  it('accepts a release asset of the listing repo, matching case-insensitively', () => {
    assert.equal(
      releaseWith('https://github.com/alice/example/releases/download/v1.0/example.crx').ok,
      true,
    );
    assert.equal(
      releaseWith('https://github.com/Alice/Example/releases/download/v1.0/example.crx').ok,
      true,
    );
  });

  for (const url of [
    'http://github.com/alice/example/releases/download/v1.0/example.crx',
    'https://github.com/bob/example/releases/download/v1.0/example.crx',
    'https://github.com/alice/other/releases/download/v1.0/example.crx',
    'https://github.com.evil.example/alice/example/releases/download/v1.0/example.crx',
    'https://user@github.com/alice/example/releases/download/v1.0/example.crx',
    'https://github.com/alice/example/releases/download/v1.0/example.crx?x=1',
    'https://github.com/alice/example/releases/download/v1.0/example.zip',
    'https://github.com/alice/example/releases/download/v1.0/a/example.crx',
    'https://github.com/alice/example/releases/download/../../../bob/x/releases/download/v1/x.crx',
    'https://github.com/alice/example/releases/download/%2e%2e/example.crx',
    'https://github.com/alice/example/raw/main/example.crx',
  ]) {
    it(`refuses ${url}`, () => assert.equal(releaseWith(url).ok, false));
  }

  it('refuses unknown fields and a missing version', () => {
    const result = parseRelease(JSON.stringify({ crx: 'x', extra: 1 }), repo);
    assert.ok(!result.ok);
    assert.equal(result.problems.length, 3);
  });
});

describe('parseListing and parseRepoUrl', () => {
  const good = {
    name: 'Example',
    summary: 'Does a thing.',
    author: 'alice',
    repo: 'https://github.com/alice/example',
  };

  it('accepts a good listing', () => assert.equal(parseListing(JSON.stringify(good)).ok, true));

  it('refuses a long summary, a bad login and a non-repo URL', () => {
    assert.equal(parseListing(JSON.stringify({ ...good, summary: 'x'.repeat(101) })).ok, false);
    assert.equal(parseListing(JSON.stringify({ ...good, author: '-bad' })).ok, false);
    assert.equal(
      parseListing(JSON.stringify({ ...good, repo: 'https://github.com/alice/example/tree/main' }))
        .ok,
      false,
    );
  });

  it('parses only plain GitHub repo URLs', () => {
    assert.deepEqual(parseRepoUrl('https://github.com/alice/example'), repo);
    for (const url of [
      'https://github.com/alice',
      'https://github.com/alice/..',
      'https://github.com/alice/x.git',
      'https://gitlab.com/alice/x',
    ]) {
      assert.equal(parseRepoUrl(url), undefined, url);
    }
  });
});

describe('parseClaim', () => {
  const id = 'a'.repeat(32);

  it('returns the publishers for the ID', () => {
    const claim = parseClaim(
      JSON.stringify({ extensions: { [id]: { publishers: ['alice', 'bot[bot]'] } } }),
      id,
    );
    assert.deepEqual(claim.ok && claim.value, ['alice', 'bot[bot]']);
  });

  it('refuses a missing file, a missing ID and bad logins', () => {
    assert.equal(parseClaim(undefined, id).ok, false);
    assert.equal(parseClaim(JSON.stringify({ extensions: {} }), id).ok, false);
    assert.equal(
      parseClaim(JSON.stringify({ extensions: { [id]: { publishers: ['@alice'] } } }), id).ok,
      false,
    );
    assert.equal(
      parseClaim(JSON.stringify({ extensions: { [id]: { publishers: [] } } }), id).ok,
      false,
    );
  });
});
