/**
 * Runs on every push to main (`.github/workflows/publish.yml`). For each
 * listed extension it makes sure the approved `.crx` is stored on the
 * registry's Release `<id>-<version>`, re-verifying it first, then builds the
 * site, with the store pages' data: each `.crx`'s size and icon, and the
 * review trail of every stored release. Re-running is always safe: stored releases are only compared, never
 * replaced. Any problem stops the run before the site is deployed.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { verifyCrx3 } from './crx3.ts';
import { GitHub, download } from './github.ts';
import { extractIcon } from './icon.ts';
import { compareVersions, isRecord, parseVersion } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import type { TrailRow } from './pages.ts';
import { readPermissions } from './permissions.ts';
import { trailChange } from './reach.ts';
import { REGISTRY_REPO, approvedCrxUrl } from './registry.ts';
import {
  ID_PATTERN,
  parseBlocklist,
  parseDelisted,
  parseListing,
  parseRelease,
  parseRepoUrl,
} from './schema.ts';
import type { Listing, Release } from './schema.ts';
import { buildSite } from './site.ts';
import type { SiteDetails, SiteEntry } from './site.ts';
import { standingOf } from './standing.ts';
import type { RegistryLists } from './standing.ts';
import { fileTrailCache, noTrailCache, permissionsManifest, reviewSettled } from './trail-cache.ts';
import type { CachedReview, TrailCache, TrailEntry } from './trail-cache.ts';
import { manifestOf, sha256Hex, verifyRelease } from './verify-release.ts';

const CRX_CONTENT_TYPE = 'application/x-chrome-extension';
const ID_LENGTH = 32;
/** Where publish.yml restores and saves the trail cache, relative to the checkout. */
const TRAIL_CACHE_FOLDER = '.cache/trail';

export interface ListedExtension {
  id: string;
  listing: Listing;
  release: Release;
}

/** What publishing reads and writes, behind one interface so tests can fake GitHub. */
export interface PublishTarget {
  /** Every tag on the registry's Releases, to find IDs that were ever published. */
  releaseTags(): Promise<string[]>;
  hasRelease(tag: string): Promise<boolean>;
  download(url: string): Promise<Buffer>;
  createRelease(tag: string, name: string, body: string, bytes: Buffer): Promise<void>;
  /** When each stored Release was published, by tag. Read after storing, so new ones are included. */
  releaseDates(): Promise<Map<string, string>>;
  /** `extensions/<id>/release.json` at each commit on main that changed it, newest first. */
  releaseJsonHistory(id: string): Promise<{ sha: string; text: string | undefined }[]>;
  /** The pull request a commit on main came from. */
  pullForCommit(sha: string): Promise<number | undefined>;
}

export interface PublishOptions {
  /** What earlier runs learned about each stored release. None by default: everything is gathered again. */
  cache?: TrailCache;
  /** The clock for the cache's review retries. */
  now?: () => Date;
}

export interface PublishResult {
  entries: SiteEntry[];
  stored: string[];
  problems: string[];
  /** Store page data that couldn't be gathered. The site still deploys, with less detail. */
  warnings: string[];
}

export function releaseTag(id: string, version: string): string {
  return `${id}-${version}`;
}

/** Reads and validates every `extensions/<id>/` folder in a checkout. Throws on anything malformed. */
export function readExtensions(root: string): ListedExtension[] {
  const folder = join(root, 'extensions');
  let ids: string[];
  try {
    ids = readdirSync(folder);
  } catch {
    return [];
  }
  return ids
    .filter((id) => !id.startsWith('.'))
    .map((id) => {
      if (!ID_PATTERN.test(id)) throw new Error(`extensions/${id} is not an extension ID`);
      const listing = parseListing(readFileSync(join(folder, id, 'listing.json'), 'utf8'));
      if (!listing.ok) throw new Error(`extensions/${id}: ${listing.problems.join('; ')}`);
      const repo = parseRepoUrl(listing.value.repo);
      if (!repo) throw new Error(`extensions/${id}: bad repo`);
      const release = parseRelease(readFileSync(join(folder, id, 'release.json'), 'utf8'), repo);
      if (!release.ok) throw new Error(`extensions/${id}: ${release.problems.join('; ')}`);
      return { id, listing: listing.value, release: release.value };
    });
}

/** Stores each approved release that isn't stored yet, and checks the ones that are. */
export async function publish(
  extensions: ListedExtension[],
  lists: RegistryLists,
  target: PublishTarget,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const cache = options.cache ?? noTrailCache;
  const now = options.now ?? (() => new Date());
  const result: PublishResult = { entries: [], stored: [], problems: [], warnings: [] };
  const approved: (Omit<SiteEntry, 'details'> & { bytes: Buffer })[] = [];

  // Every ID that ever had a stored release must still answer somewhere.
  const accountedFor = new Set([
    ...extensions.map((extension) => extension.id),
    ...lists.blocklist.map((entry) => entry.id),
    ...lists.delisted.filter((entry) => entry.kind === 'removed').map((entry) => entry.id),
  ]);
  const tags = await target.releaseTags();
  for (const tag of tags) {
    const id = tag.slice(0, ID_LENGTH);
    if (ID_PATTERN.test(id) && tag[ID_LENGTH] === '-' && !accountedFor.has(id)) {
      result.problems.push(
        `${id} has stored releases but no listing, blocklist entry or "removed" entry; its update file would 404`,
      );
      accountedFor.add(id);
    }
  }
  for (const entry of lists.delisted) {
    if (entry.kind === 'left' && !extensions.some((extension) => extension.id === entry.id)) {
      result.problems.push(
        `${entry.id} left the registry, so extensions/${entry.id}/ must keep its final release`,
      );
    }
  }

  for (const { id, listing, release } of extensions) {
    const standing = standingOf(id, lists);
    if (standing === 'blocked' || standing === 'removed') continue;
    const tag = releaseTag(id, release.version);
    let manifest: Manifest | undefined;
    let bytes: Buffer;
    try {
      // Sequential on purpose: one extension's GitHub writes at a time keeps failures easy to read.
      // oxlint-disable-next-line no-await-in-loop
      if (await target.hasRelease(tag)) {
        // oxlint-disable-next-line no-await-in-loop
        bytes = await target.download(approvedCrxUrl(id, release.version));
        if (sha256Hex(bytes) !== release.sha256) {
          result.problems.push(`${tag}: the stored .crx doesn't match release.json's SHA-256`);
          continue;
        }
        manifest = manifestOf(bytes, id);
      } else {
        // oxlint-disable-next-line no-await-in-loop
        bytes = await target.download(release.crx);
        const verified = verifyRelease(bytes, id, release, { leaving: standing === 'left' });
        if (verified.problems.length > 0) {
          result.problems.push(...verified.problems.map((problem) => `${tag}: ${problem}`));
          continue;
        }
        manifest = verified.manifest;
        // oxlint-disable-next-line no-await-in-loop
        await target.createRelease(
          tag,
          `${listing.name} ${release.version}`,
          `Approved copy of ${listing.name} ${release.version} from ${release.crx}\n\nSHA-256: \`${release.sha256}\``,
          bytes,
        );
        result.stored.push(tag);
      }
    } catch (error) {
      result.problems.push(`${tag}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (manifest !== undefined) approved.push({ id, standing, listing, release, manifest, bytes });
  }
  if (approved.length === 0) return result;

  // When every release the trail shows already has its date cached, the
  // Releases list isn't read again. A release stored by this run, or a draft,
  // has no cached date, so the list is read as before.
  let dates = cachedDates(approved, tags, cache);
  if (dates === undefined) {
    dates = new Map();
    try {
      dates = await target.releaseDates();
    } catch (error) {
      result.warnings.push(`Release dates: ${messageOf(error)}`);
    }
  }
  for (const { bytes, ...entry } of approved) {
    // Sequential to stay well inside GitHub's rate limits.
    // oxlint-disable-next-line no-await-in-loop
    const details = await gatherDetails(entry, bytes, dates, target, result.warnings, cache, now);
    result.entries.push({ ...entry, details });
  }
  return result;
}

/**
 * The dates of every release each approved extension's trail will show, all
 * from the cache, or `undefined` when any of them is missing there.
 */
function cachedDates(
  approved: { id: string; release: Release }[],
  tags: string[],
  cache: TrailCache,
): Map<string, string> | undefined {
  const dates = new Map<string, string>();
  for (const { id, release } of approved) {
    const versions = new Set([release.version, ...storedVersions(id, tags)]);
    for (const version of versions) {
      const tag = releaseTag(id, version);
      const publishedAt = cache.read(tag)?.publishedAt;
      if (publishedAt === undefined) return undefined;
      dates.set(tag, publishedAt);
    }
  }
  return dates;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The commit that first set each version in release.json's history (newest
 * first, as GitHub lists it): that commit is the one its review merged.
 */
export function versionCommits(
  history: { sha: string; text: string | undefined }[],
): Map<string, string> {
  const commits = new Map<string, string>();
  for (const { sha, text } of history.toReversed()) {
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const version = isRecord(parsed) ? parsed.version : undefined;
    if (typeof version === 'string' && !commits.has(version)) commits.set(version, sha);
  }
  return commits;
}

/** The versions stored on the registry's Releases for one ID, newest first. */
export function storedVersions(id: string, tags: Iterable<string>): string[] {
  const prefix = `${id}-`;
  const versions: { version: string; parts: number[] }[] = [];
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    const parts = parseVersion(version);
    if (parts !== undefined) versions.push({ version, parts });
  }
  return versions.toSorted((a, b) => compareVersions(b.parts, a.parts)).map((v) => v.version);
}

/**
 * The store page data for one approved extension: size and icon from the
 * current `.crx`, and the review trail from every stored release, diffing
 * each one's manifest with the one before it. Problems become warnings and
 * leave the detail out, since none of this affects what browsers install.
 * What it learns about each stored release goes into the cache, and what the
 * cache already holds isn't downloaded or looked up again.
 */
async function gatherDetails(
  entry: Omit<SiteEntry, 'details'>,
  bytes: Buffer,
  dates: Map<string, string>,
  target: PublishTarget,
  warnings: string[],
  cache: TrailCache,
  now: () => Date,
): Promise<SiteDetails> {
  const { id, release, manifest } = entry;
  let icon: Buffer | undefined;
  try {
    icon = extractIcon(verifyCrx3(bytes).archive, manifest);
  } catch (error) {
    warnings.push(`${id} icon: ${messageOf(error)}`);
  }

  const versions = storedVersions(id, dates.keys());
  if (!versions.includes(release.version)) versions.unshift(release.version);
  const cached = new Map(versions.map((version) => [version, cache.read(releaseTag(id, version))]));
  const manifests = new Map<string, Manifest | undefined>([[release.version, manifest]]);
  for (const version of versions) {
    if (manifests.has(version)) continue;
    const permissions = cached.get(version)?.permissions;
    if (permissions !== undefined) {
      manifests.set(version, permissionsManifest(permissions));
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      const older = await target.download(approvedCrxUrl(id, version));
      manifests.set(version, manifestOf(older, id));
    } catch (error) {
      warnings.push(`${releaseTag(id, version)} manifest: ${messageOf(error)}`);
      manifests.set(version, undefined);
    }
  }

  // release.json's history is only walked when some version's review isn't settled in the cache.
  const checkedAt = now();
  let reviews = new Map<string, string>();
  // Without the history nothing new is known, so no "not found" answers are cached either.
  let historyFailed = false;
  if (versions.some((version) => !reviewSettled(cached.get(version)?.review, checkedAt))) {
    try {
      reviews = versionCommits(await target.releaseJsonHistory(id));
    } catch (error) {
      warnings.push(`${id} review history: ${messageOf(error)}`);
      historyFailed = true;
    }
  }

  const trail: TrailRow[] = [];
  for (const [index, version] of versions.entries()) {
    const current = manifests.get(version);
    const olderVersion = versions[index + 1];
    const previous = olderVersion === undefined ? undefined : manifests.get(olderVersion);
    const change =
      olderVersion === undefined
        ? trailChange(undefined, current ?? {})
        : current === undefined || previous === undefined
          ? { text: 'Permission change unknown', adds: false }
          : trailChange(previous, current);
    const tag = releaseTag(id, version);
    const known = cached.get(version);
    let review: number | undefined;
    let reviewState: CachedReview | undefined = known?.review;
    if (reviewSettled(known?.review, checkedAt)) {
      review = known?.review !== undefined && 'pr' in known.review ? known.review.pr : undefined;
    } else if (!historyFailed) {
      const sha = reviews.get(version);
      try {
        if (sha !== undefined) {
          // oxlint-disable-next-line no-await-in-loop
          review = await target.pullForCommit(sha);
        }
        reviewState =
          review === undefined ? { missingCheckedAt: checkedAt.toISOString() } : { pr: review };
      } catch (error) {
        warnings.push(`${tag} review: ${messageOf(error)}`);
      }
    }
    const publishedAt = dates.get(tag);
    trail.push({
      version,
      date: publishedAt ?? new Date().toISOString(),
      change,
      ...(review === undefined ? {} : { review }),
    });

    // A failed Releases list leaves the cached date as it was.
    const cachedPublishedAt = publishedAt ?? known?.publishedAt;
    const learned: TrailEntry = {
      tag,
      ...(current === undefined ? {} : { permissions: readPermissions(current) }),
      ...(cachedPublishedAt === undefined ? {} : { publishedAt: cachedPublishedAt }),
      ...(reviewState === undefined ? {} : { review: reviewState }),
    };
    if (JSON.stringify(learned) !== JSON.stringify(known)) {
      try {
        cache.write(learned);
      } catch (error) {
        warnings.push(`${tag} cache: ${messageOf(error)}`);
      }
    }
  }
  return { size: bytes.length, ...(icon === undefined ? {} : { icon }), trail };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** The workflow entry point: `node scripts/publish.ts <output folder>`. */
async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (outDir === undefined) throw new Error('Usage: node scripts/publish.ts <output folder>');
  const root = join(import.meta.dirname, '..');
  const cache = fileTrailCache(join(root, TRAIL_CACHE_FOLDER));
  const github = new GitHub(requiredEnv('GITHUB_TOKEN'));
  const commit = requiredEnv('GITHUB_SHA');

  const lists: RegistryLists = {
    blocklist: parseBlocklist(readFileSync(join(root, 'blocklist.json'), 'utf8')),
    delisted: parseDelisted(readFileSync(join(root, 'delisted.json'), 'utf8')),
  };
  const result = await publish(
    readExtensions(root),
    lists,
    {
      releaseTags: async () => github.releaseTags(REGISTRY_REPO),
      hasRelease: async (tag) => github.hasRelease(REGISTRY_REPO, tag),
      download,
      releaseDates: async () => github.releaseDates(REGISTRY_REPO),
      releaseJsonHistory: async (id) => {
        const path = `extensions/${id}/release.json`;
        const shas = await github.commitsFor(REGISTRY_REPO, path);
        const history: { sha: string; text: string | undefined }[] = [];
        for (const sha of shas) {
          // oxlint-disable-next-line no-await-in-loop
          history.push({ sha, text: await github.fileText(REGISTRY_REPO, path, sha) });
        }
        return history;
      },
      pullForCommit: async (sha) => github.pullForCommit(REGISTRY_REPO, sha),
      createRelease: async (tag, name, body, bytes) =>
        github.createRelease(
          REGISTRY_REPO,
          { tag, target: commit, name, body },
          { name: `${tag.slice(0, tag.indexOf('-'))}.crx`, contentType: CRX_CONTENT_TYPE, bytes },
        ),
    },
    { cache },
  );
  for (const tag of result.stored) console.log(`Stored ${tag}`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(problem);
    throw new Error('Publishing stopped; the site was not rebuilt');
  }

  rmSync(outDir, { recursive: true, force: true });
  for (const [path, content] of buildSite(result.entries, lists)) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  console.log(`Built the site for ${result.entries.length} extensions`);
}

if (import.meta.main) await main();
