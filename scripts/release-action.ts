/**
 * The steps of the publish Action (`actions/publish/action.yml`) that authors
 * run in their own repo:
 *
 * - `pack`: packs and signs the extension folder with SHELF_SIGNING_KEY and
 *   writes the `.crx` to RUNNER_TEMP. The key stays in memory.
 * - `summary`: after the Release is created, downloads its asset, checks it is
 *   the same bytes, and writes the job summary: release.json (and a draft
 *   listing.json for a new listing) with links that open the Shelf PR in the
 *   browser. The Action never holds a token for the registry.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitHub, download } from './github.ts';
import { isRecord } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { loadSigningKey, packExtension } from './pack.ts';
import { REGISTRY_REPO } from './registry.ts';
import { parseListing, parseRepoUrl } from './schema.ts';
import type { Listing, Release } from './schema.ts';
import { sha256Hex, verifyRelease } from './verify-release.ts';

const REGISTRY_BRANCH = 'main';
const GITHUB_ORIGIN = 'https://github.com';
const JSON_INDENT = 2;
/** Matches schema.ts's limits for listing.json. */
const MAX_LISTING_NAME = 50;
const MAX_LISTING_SUMMARY = 100;
const SUMMARY_PLACEHOLDER = 'One line about what it does, under 100 characters.';
const NAME_PLACEHOLDER = 'Your extension name';
const LOCALIZED_PREFIX = '__MSG_';
const FLAG_NOTE =
  'Users install from Shelf with the flag `#extension-mime-request-handling` set to "Always prompt for install".';

export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

export function tagFor(version: string): string {
  return `v${version}`;
}

export function assetNameFor(id: string, version: string): string {
  return `${id}-${version}.crx`;
}

export function releaseAssetUrl(repo: string, tag: string, asset: string): string {
  return `${GITHUB_ORIGIN}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

function manifestText(manifest: Manifest, key: string): string | undefined {
  const value = manifest[key];
  return typeof value === 'string' && value.trim() !== '' && !value.startsWith(LOCALIZED_PREFIX)
    ? value.trim()
    : undefined;
}

/**
 * A first listing.json from the manifest. `author` is whoever ran the workflow,
 * since the PR check needs it in shelf.json's publishers (an organisation
 * owner can't be). The author edits it before opening the PR.
 */
export function draftListing(manifest: Manifest, repo: string, author: string): Listing {
  const name = manifestText(manifest, 'name');
  const summary = manifestText(manifest, 'description');
  return {
    name: name !== undefined && name.length <= MAX_LISTING_NAME ? name : NAME_PLACEHOLDER,
    summary:
      summary !== undefined && summary.length <= MAX_LISTING_SUMMARY
        ? summary
        : SUMMARY_PLACEHOLDER,
    author,
    repo: `${GITHUB_ORIGIN}/${repo}`,
  };
}

export interface SummaryInput {
  id: string;
  release: Release;
  /** The author's repo, `owner/name`. */
  repo: string;
  /** listing.json on the registry's main, or `undefined` for a new listing. */
  existingListing: string | undefined;
  /** For a new listing: the draft listing.json. */
  draft: Listing;
}

/** The job summary, in Markdown. */
export function renderSummary(input: SummaryInput): string {
  const { id, release, repo } = input;
  const folder = `extensions/${id}`;
  const releaseJson = jsonFile(release);
  const lines = [
    `## Shelf release ${release.version}`,
    '',
    `Signed \`.crx\` for \`${id}\`: ${release.crx}`,
    '',
  ];

  if (input.existingListing === undefined) {
    const listingJson = jsonFile(input.draft);
    const newFile = (name: string, content: string): string =>
      `${GITHUB_ORIGIN}/${REGISTRY_REPO}/new/${REGISTRY_BRANCH}?filename=${encodeURIComponent(`${folder}/${name}`)}&value=${encodeURIComponent(content)}`;
    lines.push(
      '### New listing',
      '',
      `1. [Create release.json on Shelf](${newFile('release.json', releaseJson)}). Choose "Propose new file", but don't open the PR yet.`,
      `2. On the branch it made in your fork, choose Add file, then Create new file. Name it \`${folder}/listing.json\` and paste the listing.json below. Check the name and summary.`,
      '3. Open the pull request with both files.',
      '',
      '`listing.json`:',
      '',
      '```json',
      listingJson.trimEnd(),
      '```',
    );
    if (input.draft.name === NAME_PLACEHOLDER || input.draft.summary === SUMMARY_PLACEHOLDER) {
      lines.push(
        '',
        '> [!NOTE]',
        '> Replace the placeholder name or summary before you open the PR.',
      );
    }
  } else {
    const parsed = parseListing(input.existingListing);
    const listedRepo = parsed.ok ? parseRepoUrl(parsed.value.repo) : undefined;
    lines.push(
      '### Release',
      '',
      `1. [Edit release.json on Shelf](${GITHUB_ORIGIN}/${REGISTRY_REPO}/edit/${REGISTRY_BRANCH}/${folder}/release.json).`,
      '2. Replace everything in it with the content below.',
      '3. Choose "Propose changes", then open the pull request.',
    );
    if (
      listedRepo !== undefined &&
      `${listedRepo.owner}/${listedRepo.name}`.toLowerCase() !== repo.toLowerCase()
    ) {
      lines.push(
        '',
        '> [!WARNING]',
        `> Shelf lists this extension with the repo https://github.com/${listedRepo.owner}/${listedRepo.name}. The PR check only accepts a .crx from that repo.`,
      );
    }
  }
  lines.push(
    '',
    '`release.json`:',
    '',
    '```json',
    releaseJson.trimEnd(),
    '```',
    '',
    `The PR must come from a GitHub account listed in \`shelf.json\` at the root of ${repo}.`,
    '',
    FLAG_NOTE,
    '',
  );
  return lines.join('\n');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

function setOutputs(outputs: Record<string, string>): void {
  const file = requiredEnv('GITHUB_OUTPUT');
  for (const [name, value] of Object.entries(outputs)) appendFileSync(file, `${name}=${value}\n`);
}

function pack(): void {
  const pem = requiredEnv('SHELF_SIGNING_KEY');
  delete process.env.SHELF_SIGNING_KEY;
  const root = process.env.SHELF_PATH ?? '.';
  const packed = packExtension(root, loadSigningKey(pem));
  const dir = join(requiredEnv('RUNNER_TEMP'), 'shelf');
  mkdirSync(dir, { recursive: true });
  const asset = assetNameFor(packed.id, packed.version);
  const file = join(dir, asset);
  writeFileSync(file, packed.crx);
  writeFileSync(join(dir, 'manifest.json'), jsonFile(packed.manifest));
  setOutputs({
    id: packed.id,
    version: packed.version,
    tag: tagFor(packed.version),
    asset,
    file,
    sha256: packed.sha256,
  });
  process.stdout.write(`Packed ${packed.id} ${packed.version}, SHA-256 ${packed.sha256}\n`);
}

async function writeSummary(): Promise<void> {
  const repo = requiredEnv('GITHUB_REPOSITORY');
  const id = requiredEnv('SHELF_ID');
  const version = requiredEnv('SHELF_VERSION');
  const file = requiredEnv('SHELF_FILE');
  const local = readFileSync(file);
  const release: Release = {
    version,
    crx: releaseAssetUrl(repo, tagFor(version), assetNameFor(id, version)),
    sha256: sha256Hex(local),
  };

  // The registry downloads this URL without a token, so this proves the repo is public.
  let published: Buffer;
  try {
    published = await download(release.crx);
  } catch (error) {
    throw new Error(
      `Could not download ${release.crx} (${String(error)}). Shelf needs a public repo.`,
      { cause: error },
    );
  }
  const verified = verifyRelease(published, id, release);
  if (verified.problems.length > 0) throw new Error(verified.problems.join('\n'));

  const github = new GitHub(requiredEnv('GITHUB_TOKEN'));
  const existingListing = await github.fileText(
    REGISTRY_REPO,
    `extensions/${id}/listing.json`,
    REGISTRY_BRANCH,
  );
  const parsed: unknown = JSON.parse(readFileSync(join(file, '..', 'manifest.json'), 'utf8'));
  const manifest: Manifest = isRecord(parsed) ? parsed : {};
  const markdown = renderSummary({
    id,
    release,
    repo,
    existingListing,
    draft: draftListing(manifest, repo, requiredEnv('GITHUB_ACTOR')),
  });
  appendFileSync(requiredEnv('GITHUB_STEP_SUMMARY'), markdown);
  process.stdout.write(markdown);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  try {
    if (command === 'pack') pack();
    else if (command === 'summary') await writeSummary();
    else throw new Error('Usage: node scripts/release-action.ts pack|summary');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    for (const line of error.message.split('\n')) process.stdout.write(`::error::${line}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
