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
import { manifestOf, sha256Hex, verifyRelease } from './verify-release.ts';

const CRX_CONTENT_TYPE = 'application/x-chrome-extension';
const ID_LENGTH = 32;

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
): Promise<PublishResult> {
  const result: PublishResult = { entries: [], stored: [], problems: [], warnings: [] };
  const approved: (Omit<SiteEntry, 'details'> & { bytes: Buffer })[] = [];

  // Every ID that ever had a stored release must still answer somewhere.
  const accountedFor = new Set([
    ...extensions.map((extension) => extension.id),
    ...lists.blocklist.map((entry) => entry.id),
    ...lists.delisted.filter((entry) => entry.kind === 'removed').map((entry) => entry.id),
  ]);
  for (const tag of await target.releaseTags()) {
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

  let dates = new Map<string, string>();
  try {
    dates = await target.releaseDates();
  } catch (error) {
    result.warnings.push(`Release dates: ${messageOf(error)}`);
  }
  for (const { bytes, ...entry } of approved) {
    // Sequential to stay well inside GitHub's rate limits.
    // oxlint-disable-next-line no-await-in-loop
    const details = await gatherDetails(entry, bytes, dates, target, result.warnings);
    result.entries.push({ ...entry, details });
  }
  return result;
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
 */
async function gatherDetails(
  entry: Omit<SiteEntry, 'details'>,
  bytes: Buffer,
  dates: Map<string, string>,
  target: PublishTarget,
  warnings: string[],
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
  const manifests = new Map<string, Manifest | undefined>([[release.version, manifest]]);
  for (const version of versions) {
    if (manifests.has(version)) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop
      const older = await target.download(approvedCrxUrl(id, version));
      manifests.set(version, manifestOf(older, id));
    } catch (error) {
      warnings.push(`${releaseTag(id, version)} manifest: ${messageOf(error)}`);
      manifests.set(version, undefined);
    }
  }

  let reviews = new Map<string, string>();
  try {
    reviews = versionCommits(await target.releaseJsonHistory(id));
  } catch (error) {
    warnings.push(`${id} review history: ${messageOf(error)}`);
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
    let review: number | undefined;
    const sha = reviews.get(version);
    if (sha !== undefined) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        review = await target.pullForCommit(sha);
      } catch (error) {
        warnings.push(`${releaseTag(id, version)} review: ${messageOf(error)}`);
      }
    }
    trail.push({
      version,
      date: dates.get(releaseTag(id, version)) ?? new Date().toISOString(),
      change,
      ...(review === undefined ? {} : { review }),
    });
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
  const github = new GitHub(requiredEnv('GITHUB_TOKEN'));
  const commit = requiredEnv('GITHUB_SHA');

  const lists: RegistryLists = {
    blocklist: parseBlocklist(readFileSync(join(root, 'blocklist.json'), 'utf8')),
    delisted: parseDelisted(readFileSync(join(root, 'delisted.json'), 'utf8')),
  };
  const result = await publish(readExtensions(root), lists, {
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
  });
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
