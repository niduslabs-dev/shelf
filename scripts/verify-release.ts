/**
 * The checks a downloaded `.crx` must pass against its release.json, shared by
 * the PR check and publish so the two can't drift apart: the SHA-256 recorded
 * in release.json, the CRX3 signature, the ID, and the manifest.
 */
import { createHash } from 'node:crypto';

import { Crx3Error, verifyCrx3 } from './crx3.ts';
import { ManifestError, checkManifest, readManifest } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import type { Release } from './schema.ts';
import { ZipError } from './zip.ts';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface VerifiedRelease {
  problems: string[];
  /** Present once the archive was read, even if some manifest checks failed. */
  manifest: Manifest | undefined;
}

/** Reads the manifest of a `.crx` that must be signed for `id`. Throws on anything Chromium would refuse. */
export function manifestOf(bytes: Uint8Array, id: string): Manifest {
  const crx = verifyCrx3(bytes);
  if (crx.id !== id)
    throw new Crx3Error('REQUIRED_PROOF_MISSING', `The .crx is signed for ID ${crx.id}, not ${id}`);
  return readManifest(crx.archive);
}

export function verifyRelease(
  bytes: Uint8Array,
  id: string,
  release: Release,
  currentVersion?: string,
): VerifiedRelease {
  const actual = sha256Hex(bytes);
  if (actual !== release.sha256) {
    return {
      problems: [`The .crx's SHA-256 is ${actual}, but release.json says ${release.sha256}`],
      manifest: undefined,
    };
  }
  let manifest: Manifest;
  try {
    manifest = manifestOf(bytes, id);
  } catch (error) {
    if (error instanceof Crx3Error || error instanceof ZipError || error instanceof ManifestError) {
      return { problems: [`The .crx was refused: ${error.message}`], manifest: undefined };
    }
    throw error;
  }
  return {
    problems: checkManifest(manifest, { id, version: release.version, currentVersion }),
    manifest,
  };
}
