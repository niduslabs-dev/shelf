/**
 * The extension's icon for the store pages, taken from the verified archive
 * with the strict zip reader. Only PNG is served (it is what Chromium expects
 * and what the page can show without sniffing), capped in size. Anything odd
 * means no icon, and the page falls back to a letter tile.
 */
import { isRecord } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { ZipError, readFile } from './zip.ts';

export const MAX_ICON_BYTES = 512 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The manifest's `icons` PNG paths, largest size first. */
export function iconPaths(manifest: Manifest): string[] {
  const { icons } = manifest;
  if (!isRecord(icons)) return [];
  return Object.entries(icons)
    .flatMap(([size, path]) =>
      typeof path === 'string' && /^\d+$/.test(size) && /\.png$/i.test(path)
        ? [{ size: Number(size), path: path.replace(/^\/+/, '') }]
        : [],
    )
    .toSorted((a, b) => b.size - a.size)
    .map((icon) => icon.path);
}

/** The largest readable PNG icon, or `undefined` when there's none. Never throws on a bad archive entry. */
export function extractIcon(archive: Uint8Array, manifest: Manifest): Buffer | undefined {
  for (const path of iconPaths(manifest)) {
    let bytes: Buffer | undefined;
    try {
      bytes = readFile(archive, path, MAX_ICON_BYTES);
    } catch (error) {
      if (error instanceof ZipError) continue;
      throw error;
    }
    if (bytes?.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return bytes;
  }
  return undefined;
}
