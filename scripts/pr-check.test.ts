import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { extensionId } from './crx3.ts';
import {
  REVIEW_GUIDELINES_URL,
  autoMergeVerdict,
  checkPullRequest,
  renderComment,
} from './pr-check.ts';
import type { AutoMergeFacts, CheckResult, PullRequestSource } from './pr-check.ts';
import { approvedCrxUrl, updateUrlFor } from './registry.ts';
import type { DelistedExtension } from './schema.ts';
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
  baseRef?: string;
  prFiles?: Record<string, string>;
  statuses?: Record<string, string>;
  mainFiles?: Record<string, string>;
  claim?: string;
  downloads?: Record<string, Buffer>;
  blocked?: string[];
  delisted?: DelistedExtension[];
}

function fakePr(fake: Fake): PullRequestSource {
  const prFiles = fake.prFiles ?? {};
  return {
    author: fake.author ?? 'alice',
    baseRef: fake.baseRef ?? 'main',
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
    lists: {
      blocklist: (fake.blocked ?? []).map((id) => ({
        id,
        reason: 'Shipped malware',
        date: '2026-11-16',
      })),
      delisted: fake.delisted ?? [],
    },
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
    assert.match(result.report ?? '', /No permission changes/);
    assert.deepEqual(result.versions, { from: '1.0', to: '1.1' });
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

  it('refuses a removed extension', async () => {
    const delisted: DelistedExtension[] = [
      { id: ID, kind: 'removed', reason: 'Author asked', date: '2026-11-16' },
    ];
    assert.match(
      await problems(release('1.1', crx('1.1'), { delisted })),
      /removed from Shelf .*Author asked/,
    );
  });

  it('accepts one final release that moves update_url away, once the maintainer marked it as leaving', async () => {
    const delisted: DelistedExtension[] = [
      { id: ID, kind: 'left', reason: 'Moving to own server', date: '2026-11-16' },
    ];
    const away = 'https://example.com/updates.xml';
    const result = await checkPullRequest(
      fakePr(release('2.0', crx('2.0', { update_url: away }), { delisted })),
    );
    assert.deepEqual(result.problems, []);
    assert.equal(result.leavingTo, away);
    assert.equal(result.needsCloseReview, true);
    assert.match(renderComment(result), /Final release/);
  });

  it('refuses a final release that still points at the registry', async () => {
    const delisted: DelistedExtension[] = [
      { id: ID, kind: 'left', reason: 'x', date: '2026-11-16' },
    ];
    assert.match(
      await problems(release('2.0', crx('2.0'), { delisted })),
      /final release must move update_url/,
    );
  });

  it('refuses moving update_url away without the maintainer marking it as leaving', async () => {
    assert.match(
      await problems(release('2.0', crx('2.0', { update_url: 'https://example.com/u.xml' }))),
      /update_url must be https:\/\/shelf/,
    );
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

async function verdictOf(fake: Fake): Promise<string> {
  const { autoMerge } = await checkPullRequest(fakePr(fake));
  return autoMerge.eligible ? 'eligible' : autoMerge.reasons.join('; ');
}

describe('auto-merge eligibility', () => {
  it('allows a listed release by a publisher that changes only release.json and adds nothing', async () => {
    assert.equal(await verdictOf(release('1.1', crx('1.1'))), 'eligible');
    assert.equal(
      await verdictOf(release('1.1', crx('1.1'), { author: 'example-bot[bot]' })),
      'eligible',
    );
  });

  it('allows a release that only removes permissions', async () => {
    assert.equal(await verdictOf(release('1.1', crx('1.1', { permissions: [] }))), 'eligible');
  });

  it('refuses a new listing', async () => {
    assert.match(await verdictOf(newListing()), /a new listing/);
  });

  it('refuses a final release of an extension that is leaving', async () => {
    const delisted: DelistedExtension[] = [
      { id: ID, kind: 'left', reason: 'Moving', date: '2026-11-16' },
    ];
    const fake = release('2.0', crx('2.0', { update_url: 'https://example.com/u.xml' }), {
      delisted,
    });
    assert.match(await verdictOf(fake), /a final release/);
  });

  it('refuses a blocked or removed extension', async () => {
    assert.match(await verdictOf(release('1.1', crx('1.1'), { blocked: [ID] })), /is blocked/);
    const delisted: DelistedExtension[] = [
      { id: ID, kind: 'removed', reason: 'x', date: '2026-11-16' },
    ];
    assert.match(await verdictOf(release('1.1', crx('1.1'), { delisted })), /is removed/);
  });

  it('refuses a PR into another branch', async () => {
    assert.match(
      await verdictOf(release('1.1', crx('1.1'), { baseRef: 'old' })),
      /targets old, not main/,
    );
  });

  it('refuses a PR that changes anything besides release.json', async () => {
    const editsListing = release('1.1', crx('1.1'));
    editsListing.prFiles = { ...editsListing.prFiles, [`${folder}/listing.json`]: listing };
    assert.match(await verdictOf(editsListing), /changes more than release\.json/);
    assert.match(
      await verdictOf({ prFiles: { 'scripts/pr-check.ts': '' } }),
      /changes more than release\.json/,
    );
  });

  it('refuses when any check has a problem', async () => {
    assert.match(await verdictOf(release('1.0', crx('1.0'))), /not every check passed/);
  });

  it('refuses when the approved release could not be compared', async () => {
    const fake = release('1.1', crx('1.1'));
    delete fake.downloads![approvedCrxUrl(ID, '1.0')];
    assert.match(await verdictOf(fake), /permissions not compared/);
  });

  for (const [what, extra] of [
    ['permissions', { permissions: ['storage', 'tabs'] }],
    ['host permissions', { host_permissions: ['https://example.com/*'] }],
    ['optional permissions', { optional_permissions: ['bookmarks'] }],
    ['optional host permissions', { optional_host_permissions: ['<all_urls>'] }],
    [
      'content-script matches',
      { content_scripts: [{ matches: ['https://example.com/*'], js: ['a.js'] }] },
    ],
  ] as const) {
    it(`refuses a release that adds ${what}`, async () => {
      assert.match(await verdictOf(release('1.1', crx('1.1', extra))), /adds permissions/);
    });
  }

  it('refuses a release that changes other manifest keys', async () => {
    assert.match(
      await verdictOf(release('1.1', crx('1.1', { background: { service_worker: 'b.js' } }))),
      /changes the manifest's background/,
    );
  });

  it('refuses an author who is not a publisher', async () => {
    assert.match(
      await verdictOf(release('1.1', crx('1.1'), { author: 'mallory' })),
      /the author is not a publisher in shelf\.json/,
    );
    const noClaim = release('1.1', crx('1.1'));
    delete noClaim.claim;
    assert.match(await verdictOf(noClaim), /the author is not a publisher/);
  });

  it('lists every reason that applies', () => {
    const facts: AutoMergeFacts = {
      id: ID,
      kind: 'new listing',
      standing: 'listed',
      baseRef: 'main',
      files: [{ path: `${folder}/listing.json`, status: 'added' }],
      problems: ['x'],
      diff: undefined,
      authorIsPublisher: false,
    };
    assert.deepEqual(autoMergeVerdict(facts), {
      eligible: false,
      reasons: [
        'a new listing',
        'changes more than release.json',
        'not every check passed',
        'the author is not a publisher in shelf.json',
      ],
    });
  });

  it('refuses a release.json that was added rather than edited', () => {
    const verdict = autoMergeVerdict({
      id: ID,
      kind: 'release',
      standing: 'listed',
      baseRef: 'main',
      files: [{ path: `${folder}/release.json`, status: 'added' }],
      problems: [],
      diff: { permissions: [], addsPermissions: false, otherChangedKeys: [] },
      authorIsPublisher: true,
    });
    assert.deepEqual(verdict.reasons, ['changes more than release.json']);
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
    versions: undefined,
    leavingTo: undefined,
    autoMerge: { eligible: true, reasons: [] },
  };

  it('neutralises mentions, HTML and backticks from PR content', () => {
    const body = renderComment(
      { ...base, problems: ['version "@everyone <img src=x>" `x`'] },
      { name: '@octocat', summary: '<script>', author: 'alice', repo: REPO },
    );
    assert.doesNotMatch(body, /@everyone|@octocat|<img|<script>/);
    assert.match(body, /1 problem/);
  });

  it('shows the version change', () => {
    assert.match(
      renderComment({ ...base, versions: { from: '1.0', to: '1.1' } }),
      /Version 1\.0 → 1\.1/,
    );
    assert.match(
      renderComment({ ...base, versions: { from: undefined, to: '1.0' } }),
      /Version 1\.0\n/,
    );
  });

  it('says when a PR is eligible for auto-merge and links the review guidelines', () => {
    const body = renderComment(base);
    assert.match(body, /\*\*Eligible for auto-merge\.\*\*/);
    assert.ok(body.includes(`[review guidelines](${REVIEW_GUIDELINES_URL})`));
    assert.equal(
      REVIEW_GUIDELINES_URL,
      'https://github.com/niduslabs-dev/shelf/blob/main/REVIEW.md',
    );
  });

  it('says why a PR is reviewed by hand, with untrusted keys neutralised', () => {
    const body = renderComment({
      ...base,
      autoMerge: { eligible: false, reasons: ['adds permissions', "changes the manifest's <b>@x"] },
    });
    assert.match(
      body,
      /\*\*Reviewed by hand:\*\* adds permissions; changes the manifest's &lt;b>@​x\./,
    );
    assert.doesNotMatch(body, /Eligible/);
    assert.ok(body.includes(REVIEW_GUIDELINES_URL));
  });

  it('carries the marker so the next run edits the same comment', () => {
    assert.match(renderComment(base), /^<!-- shelf-pr-check -->/);
  });
});
