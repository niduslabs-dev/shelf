/**
 * A strict zip reader for the archive inside a `.crx`, using `node:zlib` only.
 * It reads the central directory, refuses anything ambiguous, and extracts
 * single files by name.
 *
 * "Ambiguous" matters here: CI reads `manifest.json` from the archive, then
 * Chromium unpacks the same archive to disk. If two entries could land on the
 * same path (same name, or names that differ only in case or Unicode form,
 * which collide on macOS and Windows disks), CI and the browser could see
 * different files. Such archives are refused outright.
 */
import { crc32, inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** The key two entry names collide on when unpacked to a case-insensitive disk. */
function collisionKey(name: string): string {
  return name.replaceAll('\\', '/').normalize('NFC').toLowerCase();
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const earliest = Math.max(0, zip.length - EOCD_BYTES - MAX_COMMENT_BYTES);
  for (let pos = zip.length - EOCD_BYTES; pos >= earliest; pos--) {
    if (zip.readUInt32LE(pos) !== EOCD_SIGNATURE) continue;
    if (pos + EOCD_BYTES + zip.readUInt16LE(pos + 20) === zip.length) return pos;
  }
  throw new ZipError('No end of central directory record');
}

/** Lists every entry. Throws on Zip64, multi-disk archives, encryption and colliding names. */
export function readEntries(archive: Uint8Array): ZipEntry[] {
  const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  if (zip.length < EOCD_BYTES) throw new ZipError('Archive too small');
  const eocd = findEndOfCentralDirectory(zip);

  const diskNumber = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (count === ZIP64_MARKER_16 || centralOffset === ZIP64_MARKER_32) {
    throw new ZipError('Zip64 archives are not supported');
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== count) {
    throw new ZipError('Multi-disk archives are not supported');
  }
  if (centralOffset + centralSize > eocd) throw new ZipError('Central directory out of range');

  const entries: ZipEntry[] = [];
  const seen = new Map<string, string>();
  let pos = centralOffset;
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_HEADER_BYTES > eocd || zip.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new ZipError('Bad central directory entry');
    }
    const flags = zip.readUInt16LE(pos + 8);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const nameEnd = pos + CENTRAL_HEADER_BYTES + nameLength;
    if (nameEnd > eocd) throw new ZipError('Entry name out of range');
    const name = zip.toString('utf8', pos + CENTRAL_HEADER_BYTES, nameEnd);
    const entry: ZipEntry = {
      name,
      method: zip.readUInt16LE(pos + 10),
      crc: zip.readUInt32LE(pos + 16),
      compressedSize: zip.readUInt32LE(pos + 20),
      size: zip.readUInt32LE(pos + 24),
      localHeaderOffset: zip.readUInt32LE(pos + 42),
    };
    if (flags & FLAG_ENCRYPTED) throw new ZipError(`${name} is encrypted`);
    if (
      entry.compressedSize === ZIP64_MARKER_32 ||
      entry.size === ZIP64_MARKER_32 ||
      entry.localHeaderOffset === ZIP64_MARKER_32
    ) {
      throw new ZipError('Zip64 archives are not supported');
    }
    const key = collisionKey(name);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new ZipError(`${earlier} and ${name} would unpack to the same file`);
    }
    seen.set(key, name);
    entries.push(entry);
    pos = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/**
 * Extracts one file by its exact name (at the archive root unless the name has
 * a path). Returns `undefined` when there's no such entry. Checks the local
 * header agrees with the central directory, the size limit and the CRC.
 */
export function readFile(archive: Uint8Array, name: string, maxBytes: number): Buffer | undefined {
  const entry = readEntries(archive).find((candidate) => candidate.name === name);
  if (entry === undefined) return undefined;
  if (entry.size > maxBytes) throw new ZipError(`${name} is larger than ${maxBytes} bytes`);

  const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const local = entry.localHeaderOffset;
  if (local + LOCAL_HEADER_BYTES > zip.length || zip.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new ZipError(`Bad local header for ${name}`);
  }
  const localNameLength = zip.readUInt16LE(local + 26);
  const localExtraLength = zip.readUInt16LE(local + 28);
  const localName = zip.toString(
    'utf8',
    local + LOCAL_HEADER_BYTES,
    local + LOCAL_HEADER_BYTES + localNameLength,
  );
  if (localName !== name) throw new ZipError(`Local header names ${localName}, not ${name}`);
  const dataStart = local + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.length) throw new ZipError(`${name} runs past the end of the archive`);
  const data = zip.subarray(dataStart, dataEnd);

  let content: Buffer;
  switch (entry.method) {
    case METHOD_STORED:
      content = Buffer.from(data);
      break;
    case METHOD_DEFLATE:
      try {
        content = inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch {
        throw new ZipError(`${name} could not be inflated`);
      }
      break;
    default:
      throw new ZipError(`${name} uses unsupported compression method ${entry.method}`);
  }
  if (content.length !== entry.size) throw new ZipError(`${name} has the wrong size`);
  if (crc32(content) !== entry.crc) throw new ZipError(`${name} fails its CRC check`);
  return content;
}
