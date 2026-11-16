/**
 * Runs on every push to main (`.github/workflows/publish.yml`). For each
 * listed extension it makes sure the approved `.crx` is stored on the
 * registry's Release `<id>-<version>`, re-verifying it first, then builds the
 * site. Re-running is always safe: stored releases are only compared, never
 * replaced. Any problem stops the run before the site is deployed.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { GitHub, download } from './github.ts';
import type { Manifest } from './manifest.ts';
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
import type { SiteEntry } from './site.ts';
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
}

export interface PublishResult {
  entries: SiteEntry[];
  stored: string[];
  problems: string[];
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
  const result: PublishResult = { entries: [], stored: [], problems: [] };

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
    try {
      // Sequential on purpose: one extension's GitHub writes at a time keeps failures easy to read.
      // oxlint-disable-next-line no-await-in-loop
      if (await target.hasRelease(tag)) {
        // oxlint-disable-next-line no-await-in-loop
        const stored = await target.download(approvedCrxUrl(id, release.version));
        if (sha256Hex(stored) !== release.sha256) {
          result.problems.push(`${tag}: the stored .crx doesn't match release.json's SHA-256`);
          continue;
        }
        manifest = manifestOf(stored, id);
      } else {
        // oxlint-disable-next-line no-await-in-loop
        const bytes = await target.download(release.crx);
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
    if (manifest !== undefined) result.entries.push({ id, standing, listing, release, manifest });
  }
  return result;
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
    createRelease: async (tag, name, body, bytes) =>
      github.createRelease(
        REGISTRY_REPO,
        { tag, target: commit, name, body },
        { name: `${tag.slice(0, tag.indexOf('-'))}.crx`, contentType: CRX_CONTENT_TYPE, bytes },
      ),
  });
  for (const tag of result.stored) console.log(`Stored ${tag}`);
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
