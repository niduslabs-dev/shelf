import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { extensionId } from './crx3.ts';
import { checkPullRequest, renderComment } from './pr-check.ts';
import type { CheckResult, PullRequestSource } from './pr-check.ts';
import { approvedCrxUrl, updateUrlFor } from './registry.ts';
import { packCrx3, spki } from './testing/pack-crx3.ts';
import type { Signer } from './testing/pack-crx3.ts';
import { writeZip } from './testing/write-zip.ts';
import { sha256Hex } from './verify-release.ts';

function newSigner(): Signer {
  return { algorithm: 'rsa', ...generateKeyPairSync('rsa', { modulusLength: 2048 }) };
}

const author = newSigner();
const ID = extensionId(spki(author.publicKey));
const REPO = 'https://github.com/alice/example';
const crxUrl = (tag: string) => `${REPO}/releases/download/${tag}/example.crx`;

function crx(version: string, extra: Record<string, unknown> = {}, signer = author): Buffer {
  const manifest = {
    manifest_version: 3,
    name: 'Example',
    version,
    update_url: updateUrlFor(extensionId(spki(signer.publicKey))),
    permissions: ['storage'],
    ...extra,
  };
  return packCrx3({
    archive: writeZip([
      { name: 'manifest.json', content: JSON.stringify(manifest), deflate: true },
    ]),
    signers: [signer],
  });
}

const listing = JSON.stringify({
  name: 'Example',
  summary: 'Does a thing.',
  author: 'alice',
  repo: REPO,
});
const claim = JSON.stringify({
  extensions: { [ID]: { publishers: ['alice', 'example-bot[bot]'] } },
});

interface Fake {
  author?: string;
  prFiles?: Record<string, string>;
  statuses?: Record<string, string>;
  mainFiles?: Record<string, string>;
  claim?: string;
  downloads?: Record<string, Buffer>;
  blocked?: string[];
}

function fakePr(fake: Fake): PullRequestSource {
  const prFiles = fake.prFiles ?? {};
  return {
    author: fake.author ?? 'alice',
    files: Object.keys(prFiles).map((path) => ({ path, status: fake.statuses?.[path] ?? 'added' })),
    readPrFile: async (path) => prFiles[path],
    readMainFile: async (path) => fake.mainFiles?.[path],
    readClaim: async (owner, repo) =>
      owner === 'alice' && repo === 'example' ? fake.claim : undefined,
    download: async (url) => {
      const file = fake.downloads?.[url];
      if (!file) throw new Error('HTTP 404');
      return file;
    },
    blocklist: (fake.blocked ?? []).map((id) => ({
      id,
      reason: 'Shipped malware',
      date: '2026-11-16',
    })),
  };
}

const folder = `extensions/${ID}`;
const v1 = crx('1.0');
const releaseJson = (version: string, file: Buffer) =>
  JSON.stringify({ version, crx: crxUrl(`v${version}`), sha256: sha256Hex(file) });

function newListing(overrides: Fake = {}): Fake {
  return {
    prFiles: {
      [`${folder}/listing.json`]: listing,
      [`${folder}/release.json`]: releaseJson('1.0', v1),
    },
    claim,
    downloads: { [crxUrl('v1.0')]: v1 },
    ...overrides,
  };
}

function release(version: string, file: Buffer, overrides: Fake = {}): Fake {
  return {
    prFiles: {
      [`${folder}/release.json`]: releaseJson(version, file),
    },
    statuses: { [`${folder}/release.json`]: 'modified' },
    mainFiles: {
      [`${folder}/listing.json`]: listing,
      [`${folder}/release.json`]: releaseJson('1.0', v1),
    },
    claim,
    downloads: { [crxUrl(`v${version}`)]: file, [approvedCrxUrl(ID, '1.0')]: v1 },
    ...overrides,
  };
}

async function problems(fake: Fake): Promise<string> {
  return (await checkPullRequest(fakePr(fake))).problems.join('\n');
}

describe('checkPullRequest', () => {
  it('passes a correct new listing and reports everything it can reach', async () => {
    const result = await checkPullRequest(fakePr(newListing()));
    assert.deepEqual(result.problems, []);
    assert.equal(result.kind, 'new listing');
    assert.equal(result.needsCloseReview, true);
    assert.match(result.report ?? '', /New listing[\s\S]*`storage`/);
    assert.match(result.notes.join(), /SHA-256 of the .crx: `[0-9a-f]{64}`/);
  });

  it('passes a release with the same permissions', async () => {
    const result = await checkPullRequest(fakePr(release('1.1', crx('1.1'))));
    assert.deepEqual(result.problems, []);
    assert.equal(result.kind, 'release');
    assert.equal(result.needsCloseReview, false);
    assert.match(result.report ?? '', /No new permissions/);
  });

  it('passes a release that adds permissions, marked for close review', async () => {
    const result = await checkPullRequest(
      fakePr(release('1.1', crx('1.1', { permissions: ['storage', 'cookies'] }))),
    );
    assert.deepEqual(result.problems, []);
    assert.equal(result.needsCloseReview, true);
    assert.match(result.report ?? '', /added: `cookies`/);
  });

  it('accepts a publisher bot from shelf.json', async () => {
    assert.equal(await problems(release('1.1', crx('1.1'), { author: 'example-bot[bot]' })), '');
  });

  it('refuses a PR author who is not a publisher', async () => {
    assert.match(
      await problems(release('1.1', crx('1.1'), { author: 'mallory' })),
      /mallory is not a publisher/,
    );
  });

  it('refuses when the repo has no shelf.json', async () => {
    const fake = newListing();
    delete fake.claim;
    assert.match(await problems(fake), /shelf\.json .* is missing/);
  });

  it('refuses a .crx signed with another key', async () => {
    const other = newSigner();
    assert.match(await problems(release('1.1', crx('1.1', {}, other))), /signed for ID/);
  });

  it('refuses a .crx hosted outside the listing repo', async () => {
    const fake = release('1.1', crx('1.1'));
    fake.prFiles = {
      [`${folder}/release.json`]: JSON.stringify({
        version: '1.1',
        crx: 'https://github.com/mallory/x/releases/download/v1/x.crx',
      }),
    };
    assert.match(await problems(fake), /release asset of the listing's repo/);
  });

  it('refuses a version that is not higher, or that differs from release.json', async () => {
    assert.match(await problems(release('1.0', crx('1.0'))), /must be higher/);
    assert.match(await problems(release('1.1', crx('1.2'))), /1\.2 in the manifest but 1\.1/);
  });

  it('refuses a .crx that differs from the SHA-256 in release.json', async () => {
    const fake = release('1.1', crx('1.1'));
    fake.downloads![crxUrl('v1.1')] = crx('1.1', { description: 'Swapped after review' });
    assert.match(await problems(fake), /SHA-256 is [0-9a-f]{64}, but release\.json says/);
  });

  it('refuses a blocked extension', async () => {
    assert.match(await problems(newListing({ blocked: [ID] })), /blocked .*Shipped malware/);
  });

  it('keeps the PR to one extension and its two files', async () => {
    assert.match(await problems({ prFiles: { 'scripts/pr-check.ts': '' } }), /outside a listing/);
    assert.match(
      await problems({
        prFiles: {
          [`${folder}/release.json`]: '{}',
          [`extensions/${'b'.repeat(32)}/release.json`]: '{}',
        },
      }),
      /only one extension/,
    );
    assert.match(
      await problems({
        ...release('1.1', crx('1.1')),
        statuses: { [`${folder}/release.json`]: 'removed' },
      }),
      /removed/,
    );
    const editsListing = release('1.1', crx('1.1'));
    editsListing.prFiles = { ...editsListing.prFiles, [`${folder}/listing.json`]: listing };
    assert.match(await problems(editsListing), /existing listing\.json need a maintainer/);
  });

  it('needs both files for a new listing', async () => {
    const fake = newListing();
    fake.prFiles = { [`${folder}/release.json`]: fake.prFiles![`${folder}/release.json`]! };
    assert.match(await problems(fake), /adds both/);
  });

  it('refuses a folder name that is not an ID', async () => {
    assert.match(
      await problems({ prFiles: { 'extensions/not-an-id/release.json': '{}' } }),
      /not an extension ID/,
    );
  });

  it('reports a release it cannot compare with the approved one', async () => {
    const fake = release('1.1', crx('1.1'));
    delete fake.downloads![approvedCrxUrl(ID, '1.0')];
    assert.match(await problems(fake), /Could not read the approved 1\.0/);
  });
});

describe('renderComment', () => {
  const base: CheckResult = {
    id: ID,
    kind: 'release',
    problems: [],
    notes: [],
    report: undefined,
    needsCloseReview: false,
  };

  it('neutralises mentions, HTML and backticks from PR content', () => {
    const body = renderComment(
      { ...base, problems: ['version "@everyone <img src=x>" `x`'] },
      { name: '@octocat', summary: '<script>', author: 'alice', repo: REPO },
    );
    assert.doesNotMatch(body, /@everyone|@octocat|<img|<script>/);
    assert.match(body, /1 problem/);
  });

  it('carries the marker so the next run edits the same comment', () => {
    assert.match(renderComment(base), /^<!-- shelf-pr-check -->/);
  });
});
