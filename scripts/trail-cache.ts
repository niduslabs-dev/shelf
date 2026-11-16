/**
 * The review trail's cache: one small JSON file per stored Release
 * `<id>-<version>`, holding what the trail needs from it, so publish doesn't
 * download every older `.crx` or repeat the same GitHub lookups on each run.
 * Tags are immutable (stored releases are never replaced), so an entry stays
 * valid forever. publish.yml keeps the folder between runs with
 * `actions/cache`; a missing or malformed entry is simply rebuilt.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord, parseVersion } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { PERMISSION_KINDS } from './permissions.ts';
import type { Permissions } from './permissions.ts';
import { ID_PATTERN } from './schema.ts';

const ID_LENGTH = 32;
const HOURS = 60 * 60 * 1000;
/** How long a "no review PR found" answer is trusted before publish asks GitHub again. */
export const REVIEW_RETRY_MS = 24 * HOURS;

/** A review PR that was found (final), or the time GitHub last had none (retried later). */
export type CachedReview = { pr: number } | { missingCheckedAt: string };

export interface TrailEntry {
  tag: string;
  /** The manifest's permission fields, as `readPermissions` reads them. */
  permissions?: Permissions;
  /** The Release's `published_at`. */
  publishedAt?: string;
  review?: CachedReview;
}

export interface TrailCache {
  read(tag: string): TrailEntry | undefined;
  write(entry: TrailEntry): void;
}

/** Used when no cache is given: every run gathers everything again. */
export const noTrailCache: TrailCache = { read: () => undefined, write: () => {} };

/** True for a well-formed `<id>-<version>` tag, which is also a safe file name. */
export function isTrailTag(tag: string): boolean {
  return (
    ID_PATTERN.test(tag.slice(0, ID_LENGTH)) &&
    tag[ID_LENGTH] === '-' &&
    parseVersion(tag.slice(ID_LENGTH + 1)) !== undefined
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Reads one entry, or `undefined` when it's malformed or names a different tag. */
export function parseTrailEntry(text: string, tag: string): TrailEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.tag !== tag || !isTrailTag(tag)) return undefined;
  const entry: TrailEntry = { tag };

  const { permissions, publishedAt, review } = parsed;
  if (permissions !== undefined) {
    if (!isRecord(permissions) || Object.keys(permissions).length !== PERMISSION_KINDS.length)
      return undefined;
    const read: Partial<Permissions> = {};
    for (const kind of PERMISSION_KINDS) {
      const values = permissions[kind];
      if (!isStringArray(values)) return undefined;
      read[kind] = values;
    }
    entry.permissions = {
      permissions: read.permissions ?? [],
      host_permissions: read.host_permissions ?? [],
      optional_permissions: read.optional_permissions ?? [],
      optional_host_permissions: read.optional_host_permissions ?? [],
      content_scripts: read.content_scripts ?? [],
    };
  }
  if (publishedAt !== undefined) {
    if (!isTimestamp(publishedAt)) return undefined;
    entry.publishedAt = publishedAt;
  }
  if (review !== undefined) {
    if (!isRecord(review)) return undefined;
    const { pr, missingCheckedAt } = review;
    if (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) entry.review = { pr };
    else if (isTimestamp(missingCheckedAt)) entry.review = { missingCheckedAt };
    else return undefined;
  }
  return entry;
}

/** Entries as `<folder>/<tag>.json`. */
export function fileTrailCache(folder: string): TrailCache {
  return {
    read(tag) {
      if (!isTrailTag(tag)) return undefined;
      try {
        return parseTrailEntry(readFileSync(join(folder, `${tag}.json`), 'utf8'), tag);
      } catch {
        return undefined;
      }
    },
    write(entry) {
      if (!isTrailTag(entry.tag)) throw new Error(`Not a release tag: ${entry.tag}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${entry.tag}.json`), `${JSON.stringify(entry)}\n`);
    },
  };
}

/** The cached permissions as a manifest that `readPermissions` (and so the trail's diff) reads the same way. */
export function permissionsManifest(permissions: Permissions): Manifest {
  return { ...permissions, content_scripts: [{ matches: permissions.content_scripts }] };
}

/** True when a cached review answer can be used as it is, without asking GitHub. */
export function reviewSettled(review: CachedReview | undefined, now: Date): boolean {
  if (review === undefined) return false;
  if ('pr' in review) return true;
  return now.getTime() - Date.parse(review.missingCheckedAt) < REVIEW_RETRY_MS;
}
