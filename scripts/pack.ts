/**
 * Packs an extension folder into a signed `.crx` for Shelf, the way the
 * publish Action does it for authors. The output is deterministic (same
 * folder and key, same bytes) and is checked with the registry's own
 * `verifyRelease` before it is returned, so a file that packs here passes the
 * registry's signature and manifest checks.
 *
 * The private key is only ever held in memory: it comes in as PEM text and is
 * never written anywhere.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { spki, writeCrx3 } from './crx3-write.ts';
import { extensionId } from './crx3.ts';
import { MAX_CRX_BYTES } from './github.ts';
import { ManifestError, parseVersion, readManifest } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { updateUrlFor } from './registry.ts';
import { sha256Hex, verifyRelease } from './verify-release.ts';
import { writeDeterministicZip } from './zip-write.ts';
import type { ZipInput } from './zip-write.ts';
import { ZipError } from './zip.ts';

/** File types that hold private keys. Packing refuses a folder containing one. */
const KEY_FILE_PATTERN = /\.(pem|key)$/i;

/** A problem the author has to fix. The message says how. */
export class PackError extends Error {
  override name = 'PackError';
}

export interface SigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** The extension ID this key signs for. */
  id: string;
}

/** Reads a PEM RSA private key (PKCS#1 or PKCS#8). Errors never quote the key. */
export function loadSigningKey(pem: string): SigningKey {
  if (pem.trim() === '')
    throw new PackError('The signing key is empty. Set the SHELF_SIGNING_KEY secret.');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new PackError(
      'The signing key is not a PEM private key. Paste the whole key.pem file into the secret.',
    );
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new PackError(
      `The signing key must be RSA, not ${privateKey.asymmetricKeyType}. Make one with: openssl genrsa -out key.pem 2048`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, id: extensionId(spki(publicKey)) };
}

/**
 * Every file under `root` that goes into the `.crx`, with `/`-separated paths.
 * Leaves out dotfiles and dot-folders (`.git`, `.DS_Store`, `.github`).
 * Refuses key files, symlinks and anything that isn't a plain file.
 */
export function collectFiles(root: string): ZipInput[] {
  const files: ZipInput[] = [];
  const keyFiles: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = prefix + entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, `${name}/`);
      } else if (entry.isFile()) {
        if (KEY_FILE_PATTERN.test(entry.name)) keyFiles.push(name);
        else files.push({ name, content: readFileSync(path) });
      } else {
        throw new PackError(
          `${name} is a symlink or special file. Only plain files can be packed.`,
        );
      }
    }
  };
  walk(root, '');
  if (keyFiles.length > 0) {
    throw new PackError(
      `Refusing to pack: ${keyFiles.join(', ')} looks like a private key. Move it out of the extension folder and keep it out of the repo.`,
    );
  }
  return files;
}

/** Checks made before signing. Each message says exactly what to change. */
export function checkBeforePacking(manifest: Manifest, id: string): string[] {
  const problems: string[] = [];
  if (manifest.manifest_version !== 3) {
    problems.push(
      `Set "manifest_version" to 3 in manifest.json. Shelf only lists Manifest V3 extensions (found ${JSON.stringify(manifest.manifest_version)}).`,
    );
  }
  const { version } = manifest;
  if (typeof version !== 'string' || parseVersion(version) === undefined) {
    problems.push(
      `Set "version" in manifest.json to one to four numbers separated by dots, like "1.2.0" (found ${JSON.stringify(version)}).`,
    );
  }
  const wanted = updateUrlFor(id);
  if (manifest.update_url !== wanted) {
    problems.push(
      `Set "update_url" in manifest.json to "${wanted}". That is Shelf's update URL for your signing key's ID, ${id} (found ${JSON.stringify(manifest.update_url)}).`,
    );
  }
  return problems;
}

export interface PackedExtension {
  id: string;
  version: string;
  manifest: Manifest;
  crx: Buffer;
  sha256: string;
}

/** Packs and signs the folder, then verifies the result as the registry will. */
export function packExtension(root: string, key: SigningKey): PackedExtension {
  const archive = writeDeterministicZip(collectFiles(root));
  let manifest: Manifest;
  try {
    manifest = readManifest(archive);
  } catch (error) {
    if (error instanceof ManifestError || error instanceof ZipError) {
      throw new PackError(`${error.message} (in ${root})`);
    }
    throw error;
  }
  const problems = checkBeforePacking(manifest, key.id);
  if (problems.length > 0) throw new PackError(problems.join('\n'));
  const version = String(manifest.version);

  const crx = writeCrx3(archive, key.privateKey, key.publicKey);
  if (crx.length > MAX_CRX_BYTES) {
    throw new PackError(`The .crx is ${crx.length} bytes. Shelf accepts up to ${MAX_CRX_BYTES}.`);
  }
  const sha256 = sha256Hex(crx);
  const verified = verifyRelease(crx, key.id, { version, crx: '', sha256 });
  if (verified.problems.length > 0) {
    throw new PackError(
      `The packed .crx would be refused by Shelf:\n${verified.problems.join('\n')}`,
    );
  }
  return { id: key.id, version, manifest, crx, sha256 };
}
