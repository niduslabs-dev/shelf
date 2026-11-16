/**
 * Checks a listing or release pull request (spec "Checks on every PR") and
 * builds the PR comment. `checkPullRequest` holds the logic and talks to
 * GitHub only through `PullRequestSource`, so tests can feed it fake PRs.
 *
 * Run by `.github/workflows/pr-check.yml` under `pull_request_target`: this
 * file comes from `main`, and everything read from the PR is data.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { GitHub, download } from './github.ts';
import type { PrFile } from './github.ts';
import type { Manifest } from './manifest.ts';
import { diffRelease, permissionReport } from './permissions.ts';
import type { ReleaseDiff } from './permissions.ts';
import { approvedCrxUrl, updateUrlFor } from './registry.ts';
import {
  ID_PATTERN,
  parseBlocklist,
  parseDelisted,
  parseClaim,
  parseListing,
  parseRelease,
  parseRepoUrl,
} from './schema.ts';
import type { Listing } from './schema.ts';
import { standingOf } from './standing.ts';
import type { RegistryLists, Standing } from './standing.ts';
import { manifestOf, sha256Hex, verifyRelease } from './verify-release.ts';

/**
 * What `auto-merge.yml` reads from this run's artifact. Written by this file
 * from `main`; `auto-merge.ts` still validates it before trusting a field.
 */
export interface Verdict extends AutoMergeVerdict {
  pr: number;
  headSha: string;
}

/** Finds this workflow's own comment on a PR. */
export const COMMENT_MARKER = '<!-- shelf-pr-check -->';
const EXTENSION_FILE = /^extensions\/([^/]+)\/(listing|release)\.json$/;
const MAX_PR_FILES = 2;
/** The branch releases merge into; the only base an automatic merge may target. */
export const MAIN_BRANCH = 'main';
/** Linked from every comment. */
export const REVIEW_GUIDELINES_URL = 'https://github.com/niduslabs-dev/shelf/blob/main/REVIEW.md';

/** Everything the check reads, behind one interface so tests can fake it. */
export interface PullRequestSource {
  author: string;
  /** The branch the PR merges into. */
  baseRef: string;
  files: PrFile[];
  /** A file as the PR has it. */
  readPrFile(path: string): Promise<string | undefined>;
  /** A file as `main` has it (the approved state). */
  readMainFile(path: string): Promise<string | undefined>;
  /** `shelf.json` on the default branch of the extension's own repo. */
  readClaim(owner: string, repo: string): Promise<string | undefined>;
  download(url: string): Promise<Buffer>;
  lists: RegistryLists;
}

export interface CheckResult {
  id: string | undefined;
  kind: 'new listing' | 'release' | 'unknown';
  problems: string[];
  /** Facts for the reviewer, shown whether or not the checks passed. */
  notes: string[];
  /** The permission report in Markdown, once the `.crx` was read. */
  report: string | undefined;
  /** True when the release adds permissions, is a new listing, or leaves the registry. */
  needsCloseReview: boolean;
  /** The approved version (none for a new listing) and the requested one. */
  versions: { from: string | undefined; to: string } | undefined;
  /** Set for an author's final release: where update_url moves to. */
  leavingTo: string | undefined;
  /** Whether `auto-merge.yml` may merge this PR without a person, and if not, why. */
  autoMerge: AutoMergeVerdict;
}

export interface AutoMergeVerdict {
  eligible: boolean;
  /** Why a person reviews it; empty when eligible. */
  reasons: string[];
}

/** What the auto-merge rule looks at, gathered while the checks run. */
export interface AutoMergeFacts {
  id: string | undefined;
  kind: CheckResult['kind'];
  standing: Standing | undefined;
  baseRef: string;
  files: PrFile[];
  problems: string[];
  /** The diff against the approved release; undefined when it couldn't be made. */
  diff: ReleaseDiff | undefined;
  authorIsPublisher: boolean;
}

/**
 * The auto-merge rule: only a routine release of a listed extension, by one of
 * its publishers, changing release.json alone, passing every check, and adding
 * no reach and no other manifest change. Anything else goes to a person.
 */
export function autoMergeVerdict(facts: AutoMergeFacts): AutoMergeVerdict {
  const reasons: string[] = [];
  if (facts.kind === 'new listing') reasons.push('a new listing');
  else if (facts.kind !== 'release') reasons.push('not a release PR');
  if (facts.standing !== undefined && facts.standing !== 'listed') {
    reasons.push(
      facts.standing === 'left' ? 'a final release' : `the extension is ${facts.standing}`,
    );
  }
  if (facts.baseRef !== MAIN_BRANCH) reasons.push(`targets ${facts.baseRef}, not ${MAIN_BRANCH}`);
  const [only] = facts.files;
  const onlyRelease =
    facts.files.length === 1 &&
    facts.id !== undefined &&
    only?.path === `extensions/${facts.id}/release.json` &&
    only.status === 'modified';
  if (!onlyRelease) reasons.push('changes more than release.json');
  if (facts.problems.length > 0) reasons.push('not every check passed');
  if (facts.diff === undefined) {
    if (facts.kind === 'release') reasons.push('permissions not compared');
  } else {
    if (facts.diff.addsPermissions) reasons.push('adds permissions');
    if (facts.diff.otherChangedKeys.length > 0) {
      reasons.push(`changes the manifest's ${facts.diff.otherChangedKeys.join(', ')}`);
    }
  }
  if (!facts.authorIsPublisher) reasons.push('the author is not a publisher in shelf.json');
  return { eligible: reasons.length === 0, reasons };
}

function scope(files: PrFile[]): { id: string; names: Set<string> } | string {
  if (files.length === 0) return 'The pull request changes no files';
  if (files.length > MAX_PR_FILES)
    return 'A listing or release PR changes at most listing.json and release.json';
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const file of files) {
    const match = EXTENSION_FILE.exec(file.path);
    if (!match) return `${file.path} is outside a listing; changes there need a maintainer`;
    if (file.status !== 'added' && file.status !== 'modified') {
      return `${file.path} is ${file.status}; only adding or editing listing files is automatic`;
    }
    ids.add(match[1] ?? '');
    names.add(match[2] ?? '');
  }
  const [id] = ids;
  if (ids.size !== 1 || id === undefined) return 'A PR may change only one extension';
  return { id, names };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs every check it can, collecting problems rather than stopping at the first. */
export async function checkPullRequest(pr: PullRequestSource): Promise<CheckResult> {
  const facts: AutoMergeFacts = {
    id: undefined,
    kind: 'unknown',
    standing: undefined,
    baseRef: pr.baseRef,
    files: pr.files,
    problems: [],
    diff: undefined,
    authorIsPublisher: false,
  };
  const result = await runChecks(pr, facts);
  result.autoMerge = autoMergeVerdict({
    ...facts,
    id: result.id,
    kind: result.kind,
    problems: result.problems,
  });
  return result;
}

async function runChecks(pr: PullRequestSource, facts: AutoMergeFacts): Promise<CheckResult> {
  const result: CheckResult = {
    id: undefined,
    kind: 'unknown',
    problems: [],
    notes: [],
    report: undefined,
    needsCloseReview: true,
    versions: undefined,
    leavingTo: undefined,
    autoMerge: { eligible: false, reasons: [] },
  };
  const fail = (problem: string): CheckResult => {
    result.problems.push(problem);
    return result;
  };

  const scoped = scope(pr.files);
  if (typeof scoped === 'string') return fail(scoped);
  const { id, names } = scoped;
  result.id = id;
  if (!ID_PATTERN.test(id))
    return fail(`The folder name ${id} is not an extension ID (32 letters a to p)`);

  const standing = standingOf(id, pr.lists);
  facts.standing = standing;
  const blocked = pr.lists.blocklist.find((entry) => entry.id === id);
  const delisted = pr.lists.delisted.find((entry) => entry.id === id);
  if (blocked) return fail(`This extension is blocked (${blocked.date}): ${blocked.reason}`);
  if (standing === 'removed' && delisted) {
    return fail(`This extension was removed from Shelf (${delisted.date}): ${delisted.reason}`);
  }

  const folder = `extensions/${id}`;
  const approvedListing = await pr.readMainFile(`${folder}/listing.json`);
  const approvedRelease = await pr.readMainFile(`${folder}/release.json`);
  const isNew = approvedListing === undefined;
  result.kind = isNew ? 'new listing' : 'release';
  if (isNew && !(names.has('listing') && names.has('release'))) {
    return fail('A new listing adds both listing.json and release.json');
  }
  if (!isNew && names.has('listing'))
    return fail('Changes to an existing listing.json need a maintainer');
  if (!names.has('release')) return fail('A release PR changes release.json');

  const listingText = isNew ? await pr.readPrFile(`${folder}/listing.json`) : approvedListing;
  const listing = parseListing(listingText ?? '');
  if (!listing.ok) return fail(listing.problems.join('; '));
  const repo = parseRepoUrl(listing.value.repo);
  if (!repo) return fail('listing.json "repo" is not a GitHub repo URL');

  const release = parseRelease((await pr.readPrFile(`${folder}/release.json`)) ?? '', repo);
  if (!release.ok) {
    result.problems.push(...release.problems);
    return result;
  }

  const claim = parseClaim(await pr.readClaim(repo.owner, repo.name), id);
  if (!claim.ok) {
    result.problems.push(...claim.problems);
  } else {
    const publishers = new Set(claim.value.map((login) => login.toLowerCase()));
    facts.authorIsPublisher = publishers.has(pr.author.toLowerCase());
    if (!facts.authorIsPublisher) {
      result.problems.push(
        `${pr.author} is not a publisher in shelf.json of ${repo.owner}/${repo.name}`,
      );
    }
    if (isNew && !publishers.has(listing.value.author.toLowerCase())) {
      result.problems.push(
        `listing.json "author" ${listing.value.author} is not a publisher in shelf.json`,
      );
    }
  }

  let crxBytes: Buffer;
  try {
    crxBytes = await pr.download(release.value.crx);
  } catch (error) {
    return fail(`Could not download the .crx: ${errorMessage(error)}`);
  }
  let currentVersion: string | undefined;
  let previous: Manifest | undefined;
  if (!isNew) {
    const approved = parseRelease(approvedRelease ?? '', repo);
    if (!approved.ok)
      return fail('The approved release.json on main is unreadable; a maintainer needs to look');
    currentVersion = approved.value.version;
    try {
      previous = manifestOf(await pr.download(approvedCrxUrl(id, currentVersion)), id);
    } catch (error) {
      result.problems.push(
        `Could not read the approved ${currentVersion} to compare permissions: ${errorMessage(error)}`,
      );
    }
  }

  const leaving = standing === 'left';
  if (leaving) {
    if (isNew) return fail('Only a listed extension can leave the registry');
    if (previous === undefined) return result;
    if (previous.update_url !== updateUrlFor(id)) {
      return fail('This extension already shipped its final release; it has left the registry');
    }
  }
  result.versions = { from: currentVersion, to: release.value.version };
  const verified = verifyRelease(crxBytes, id, release.value, { currentVersion, leaving });
  result.problems.push(...verified.problems);
  const { manifest } = verified;
  if (manifest === undefined) return result;
  result.notes.push(`SHA-256 of the .crx: \`${sha256Hex(crxBytes)}\` (matches release.json)`);
  if (leaving && typeof manifest.update_url === 'string') result.leavingTo = manifest.update_url;
  if (isNew || previous !== undefined) {
    result.report = permissionReport(previous, manifest);
    const diff = diffRelease(previous, manifest);
    if (!isNew) facts.diff = diff;
    result.needsCloseReview = isNew || leaving || diff.addsPermissions;
  }
  return result;
}

/** Neutralises text from the PR before it goes in a comment: no mentions, HTML or code-span breakouts. */
export function safe(value: string): string {
  return value.replaceAll('`', "'").replaceAll('<', '&lt;').replaceAll('@', '@​');
}

export function renderComment(result: CheckResult, listing?: Listing): string {
  const lines = [COMMENT_MARKER];
  const subject = result.id === undefined ? '' : ` for \`${result.id}\``;
  lines.push(
    result.problems.length === 0
      ? `### ✅ Checks passed${subject}`
      : `### ❌ ${result.problems.length === 1 ? '1 problem' : `${result.problems.length} problems`}${subject}`,
    '',
  );
  if (listing) lines.push(`**${safe(listing.name)}**: ${safe(listing.summary)}`, '');
  if (result.versions) {
    const { from, to } = result.versions;
    lines.push(
      from === undefined ? `Version ${safe(to)}` : `Version ${safe(from)} → ${safe(to)}`,
      '',
    );
  }
  if (result.leavingTo !== undefined) {
    lines.push(
      `**Final release.** It moves update_url to \`${safe(result.leavingTo)}\`. Shelf keeps serving this version's update file so older copies can follow, then lists the extension no more.`,
      '',
    );
  }
  for (const problem of result.problems) lines.push(`- ${safe(problem)}`);
  if (result.problems.length > 0) lines.push('');
  for (const note of result.notes) lines.push(`- ${note}`);
  if (result.report !== undefined) lines.push('', result.report);
  lines.push(
    '',
    result.autoMerge.eligible
      ? '**Eligible for auto-merge.**'
      : `**Reviewed by hand:** ${safe(result.autoMerge.reasons.join('; '))}.`,
    '',
    `How Shelf reviews extensions: [review guidelines](${REVIEW_GUIDELINES_URL}).`,
  );
  return lines.join('\n');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** The workflow entry point. Exits non-zero when any check fails. */
async function main(): Promise<void> {
  const github = new GitHub(requiredEnv('GITHUB_TOKEN'));
  const repo = requiredEnv('GITHUB_REPOSITORY');
  const number = Number(requiredEnv('PR_NUMBER'));
  const headRepo = requiredEnv('PR_HEAD_REPO');
  const headSha = requiredEnv('PR_HEAD_SHA');

  const source: PullRequestSource = {
    author: requiredEnv('PR_AUTHOR'),
    baseRef: requiredEnv('PR_BASE_REF'),
    files: await github.pullRequestFiles(repo, number),
    readPrFile: async (path) => github.fileText(headRepo, path, headSha),
    // Current main, not the PR's base commit: a release merged since the PR opened is the one to compare with.
    readMainFile: async (path) => github.fileText(repo, path, 'main'),
    readClaim: async (owner, name) => github.fileText(`${owner}/${name}`, 'shelf.json'),
    download,
    lists: {
      blocklist: parseBlocklist(
        readFileSync(new URL('../blocklist.json', import.meta.url), 'utf8'),
      ),
      delisted: parseDelisted(readFileSync(new URL('../delisted.json', import.meta.url), 'utf8')),
    },
  };
  const result = await checkPullRequest(source);
  const verdictPath = process.env.VERDICT_PATH;
  if (verdictPath !== undefined && verdictPath !== '') {
    const verdict: Verdict = { pr: number, headSha, ...result.autoMerge };
    writeFileSync(verdictPath, `${JSON.stringify(verdict)}\n`);
  }
  const listingPath = result.id === undefined ? undefined : `extensions/${result.id}/listing.json`;
  const listingText =
    listingPath === undefined
      ? undefined
      : ((await source.readMainFile(listingPath)) ?? (await source.readPrFile(listingPath)));
  const listing = listingText === undefined ? undefined : parseListing(listingText);
  await github.upsertComment(
    repo,
    number,
    COMMENT_MARKER,
    renderComment(result, listing?.ok ? listing.value : undefined),
  );
  if (result.problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
