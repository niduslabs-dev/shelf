/**
 * Reads `manifest.json` from a verified archive and checks it against what a
 * release asks for (spec check 4). Problems are collected, not thrown, so a PR
 * comment can list all of them at once.
 */
import { readFile } from './zip.ts';

/** The registry's origin. Every listed extension's `update_url` is fixed to it forever. */
export const REGISTRY_ORIGIN = 'https://shelf.niduslabs.dev';
/** Real manifests are a few KB; this only stops a zip bomb. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
const UTF8_BOM = '﻿';
const MAX_VERSION_PARTS = 4;
const MAX_VERSION_PART = 65535;

export class ManifestError extends Error {
  override name = 'ManifestError';
}

export type Manifest = Record<string, unknown>;

/** True for a plain JSON object (not null or an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function updateUrlFor(id: string): string {
  return `${REGISTRY_ORIGIN}/updates/${id}.xml`;
}

/**
 * Parses `manifest.json` at the archive root. Strict JSON only: Chromium
 * tolerates some extensions to JSON, but a manifest CI can't parse the same
 * way the browser does is refused rather than guessed at.
 */
export function readManifest(archive: Uint8Array): Manifest {
  const bytes = readFile(archive, 'manifest.json', MAX_MANIFEST_BYTES);
  if (bytes === undefined) throw new ManifestError('No manifest.json at the root of the archive');
  let text = bytes.toString('utf8');
  if (text.startsWith(UTF8_BOM)) text = text.slice(UTF8_BOM.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ManifestError('manifest.json is not valid JSON (comments are not allowed)');
  }
  if (!isRecord(parsed)) {
    throw new ManifestError('manifest.json is not a JSON object');
  }
  return parsed;
}

/**
 * Parses a Chromium extension version: one to four dot-separated integers from
 * 0 to 65535, with no leading zeros. Returns `undefined` when it isn't one.
 */
export function parseVersion(version: string): number[] | undefined {
  const parts = version.split('.');
  if (parts.length > MAX_VERSION_PARTS) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part)) return undefined;
    const value = Number(part);
    if (value > MAX_VERSION_PART) return undefined;
    numbers.push(value);
  }
  return numbers;
}

/** Compares two parsed versions the way Chromium does: missing parts count as 0. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export interface ReleaseExpectations {
  /** The extension ID, from the verified `.crx`. */
  id: string;
  /** `version` from release.json. */
  version: string;
  /** The version currently approved, if the extension is already listed. */
  currentVersion?: string;
}

/** Spec check 4. Returns every problem found; an empty list means the manifest passes. */
export function checkManifest(manifest: Manifest, expected: ReleaseExpectations): string[] {
  const problems: string[] = [];

  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version must be 3, found ${JSON.stringify(manifest.manifest_version)}`);
  }

  const { version } = manifest;
  if (typeof version !== 'string' || parseVersion(version) === undefined) {
    problems.push(`version ${JSON.stringify(version)} is not a valid extension version`);
  } else if (version !== expected.version) {
    problems.push(`version is ${version} in the manifest but ${expected.version} in release.json`);
  } else if (expected.currentVersion !== undefined) {
    const current = parseVersion(expected.currentVersion);
    const next = parseVersion(version);
    if (current && next && compareVersions(next, current) <= 0) {
      problems.push(
        `version ${version} must be higher than the current ${expected.currentVersion}`,
      );
    }
  }

  const wanted = updateUrlFor(expected.id);
  if (manifest.update_url !== wanted) {
    problems.push(`update_url must be ${wanted}, found ${JSON.stringify(manifest.update_url)}`);
  }

  return problems;
}
