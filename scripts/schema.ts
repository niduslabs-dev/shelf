/**
 * The registry's JSON files, and the claim file in an author's repo, checked
 * by hand: no schema library, so nothing outside `node:` runs in CI. Each
 * parser returns the typed value or a list of problems.
 */
import { isRecord } from './manifest.ts';

export const ID_PATTERN = /^[a-p]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** GitHub's login rules, plus the `[bot]` suffix of GitHub App accounts. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_NAME_LENGTH = 50;
const MAX_SUMMARY_LENGTH = 100;

export interface Listing {
  name: string;
  summary: string;
  author: string;
  repo: string;
}

export interface Release {
  version: string;
  crx: string;
  /** Lowercase hex SHA-256 of the `.crx`, so the bytes reviewed are the bytes stored. */
  sha256: string;
}

export interface RepoRef {
  owner: string;
  name: string;
}

export interface BlockedExtension {
  id: string;
  reason: string;
  date: string;
}

/** An ID that is no longer listed. Its update file still answers, so installed copies never hit a 404. */
export interface DelistedExtension {
  id: string;
  /** removed: answers "no update". left: keeps serving the author's final hand-off release. */
  kind: 'removed' | 'left';
  reason: string;
  date: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export function isLogin(value: string): boolean {
  return LOGIN_PATTERN.test(value);
}

function parseJson(text: string, file: string): Parsed<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: [`${file} is not valid JSON`] };
  }
  return isRecord(value)
    ? { ok: true, value }
    : { ok: false, problems: [`${file} is not a JSON object`] };
}

function checkKeys(value: Record<string, unknown>, allowed: string[], file: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${file} has an unknown field ${JSON.stringify(key)}`);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  file: string,
  problems: string[],
  maxLength?: number,
): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim() === '') {
    problems.push(`${file} needs a non-empty string "${key}"`);
    return '';
  }
  if (maxLength !== undefined && field.length > maxLength) {
    problems.push(`${file} "${key}" must be at most ${maxLength} characters`);
  }
  return field;
}

/** `https://github.com/<owner>/<repo>`, exactly, with nothing after it. */
export function parseRepoUrl(url: string): RepoRef | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  if (!match) return undefined;
  const [, owner = '', name = ''] = match;
  if (!isLogin(owner) || owner.endsWith('[bot]') || !REPO_NAME_PATTERN.test(name)) return undefined;
  if (name === '.' || name === '..' || name.endsWith('.git')) return undefined;
  return { owner, name };
}

export function parseListing(source: string): Parsed<Listing> {
  const file = 'listing.json';
  const json = parseJson(source, file);
  if (!json.ok) return json;
  const problems = checkKeys(json.value, ['name', 'summary', 'author', 'repo'], file);
  const name = requiredString(json.value, 'name', file, problems, MAX_NAME_LENGTH);
  const summary = requiredString(json.value, 'summary', file, problems, MAX_SUMMARY_LENGTH);
  const author = requiredString(json.value, 'author', file, problems);
  const repo = requiredString(json.value, 'repo', file, problems);
  if (author && !isLogin(author)) problems.push(`${file} "author" is not a GitHub login`);
  if (repo && !parseRepoUrl(repo)) {
    problems.push(`${file} "repo" must be https://github.com/<owner>/<repo>`);
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, value: { name, summary, author, repo } };
}

/**
 * Parses release.json. The `.crx` must be an asset of a GitHub Release in the
 * listing's own repo, so every approved file traces back to its source.
 */
export function parseRelease(source: string, repo: RepoRef): Parsed<Release> {
  const file = 'release.json';
  const json = parseJson(source, file);
  if (!json.ok) return json;
  const problems = checkKeys(json.value, ['version', 'crx', 'sha256'], file);
  const version = requiredString(json.value, 'version', file, problems);
  const crx = requiredString(json.value, 'crx', file, problems);
  const sha256 = requiredString(json.value, 'sha256', file, problems);
  if (sha256 && !SHA256_PATTERN.test(sha256)) {
    problems.push(`${file} "sha256" must be 64 lowercase hex characters`);
  }
  if (crx && !isReleaseAsset(crx, repo)) {
    problems.push(
      `${file} "crx" must be a release asset of the listing's repo: https://github.com/${repo.owner}/${repo.name}/releases/download/<tag>/<file>.crx`,
    );
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, value: { version, crx, sha256 } };
}

function isReleaseAsset(url: string, repo: RepoRef): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.href !== url || parsed.origin !== 'https://github.com') return false;
  if (
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return false;
  }
  const segments = parsed.pathname.split('/').slice(1);
  if (segments.length !== 6) return false;
  const [owner = '', name = '', releases, download, tag = '', asset = ''] = segments;
  return (
    owner.toLowerCase() === repo.owner.toLowerCase() &&
    name.toLowerCase() === repo.name.toLowerCase() &&
    releases === 'releases' &&
    download === 'download' &&
    tag !== '' &&
    asset.endsWith('.crx') &&
    !segments.some((segment) => segment === '.' || segment === '..' || segment.includes('%2'))
  );
}

/**
 * The publishers `shelf.json` in the author's repo lists for this ID, or
 * problems when the file is missing, malformed or doesn't mention the ID.
 */
export function parseClaim(source: string | undefined, id: string): Parsed<string[]> {
  const file = "shelf.json in the extension's repo";
  if (source === undefined) {
    return { ok: false, problems: [`${file} is missing (it proves you control the repo)`] };
  }
  const json = parseJson(source, file);
  if (!json.ok) return json;
  const { extensions } = json.value;
  const entry = isRecord(extensions) ? extensions[id] : undefined;
  if (!isRecord(entry)) return { ok: false, problems: [`${file} has no entry for ${id}`] };
  const publishers: unknown[] = Array.isArray(entry.publishers) ? entry.publishers : [];
  const logins = publishers.filter(
    (login): login is string => typeof login === 'string' && isLogin(login),
  );
  if (logins.length === 0 || logins.length !== publishers.length) {
    return {
      ok: false,
      problems: [`${file} needs a list of GitHub logins in extensions.${id}.publishers`],
    };
  }
  return { ok: true, value: logins };
}

export function parseBlocklist(source: string): BlockedExtension[] {
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value)) throw new Error('blocklist.json must be an array');
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.reason !== 'string' ||
      typeof item.date !== 'string'
    ) {
      throw new Error(`blocklist.json entry ${index} needs id, reason and date`);
    }
    return { id: item.id, reason: item.reason, date: item.date };
  });
}

export function parseDelisted(source: string): DelistedExtension[] {
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value)) throw new Error('delisted.json must be an array');
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      (item.kind !== 'removed' && item.kind !== 'left') ||
      typeof item.reason !== 'string' ||
      typeof item.date !== 'string'
    ) {
      throw new Error(
        `delisted.json entry ${index} needs id, kind (removed or left), reason and date`,
      );
    }
    return { id: item.id, kind: item.kind, reason: item.reason, date: item.date };
  });
}
