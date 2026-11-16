/**
 * A deterministic zip writer for packing extensions: the same files always give
 * the same bytes. Entries are sorted by name, every timestamp is the zip
 * epoch (1980-01-01 00:00), files are deflated at a fixed level, and no
 * owner, permission or extra fields are written.
 *
 * It writes only what `zip.ts` reads: no Zip64, no directory entries (Chromium
 * creates folders as it unpacks), no encryption.
 */
import { crc32, deflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
/** Version 2.0: deflate. */
const ZIP_VERSION = 20;
const METHOD_DEFLATE = 8;
/** General purpose flag bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x800;
/** DOS date for 1980-01-01 (day 1, month 1, year 0 from 1980); the DOS time is 0:00. */
const DOS_DATE_EPOCH = (1 << 5) | 1;
const DOS_TIME_MIDNIGHT = 0;
const DEFLATE_LEVEL = 9;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

export interface ZipInput {
  /** Path inside the archive, with `/` separators and no leading slash. */
  name: string;
  content: Uint8Array;
}

/** Compares names by their UTF-8 bytes, so the order never depends on locale. */
function byNameBytes(a: ZipInput, b: ZipInput): number {
  return Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));
}

export function writeDeterministicZip(files: ZipInput[]): Buffer {
  if (files.length >= MAX_UINT16) throw new Error('Too many files for a zip without Zip64');
  const sorted = files.toSorted(byNameBytes);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of sorted) {
    const name = Buffer.from(file.name, 'utf8');
    const data = deflateRawSync(file.content, { level: DEFLATE_LEVEL });
    const crc = crc32(file.content);
    const flags = /^[\x20-\x7e]*$/.test(file.name) ? 0 : FLAG_UTF8;

    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    local.writeUInt16LE(DOS_DATE_EPOCH, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12);
    central.writeUInt16LE(DOS_DATE_EPOCH, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += LOCAL_HEADER_BYTES + name.length + data.length;
    if (offset >= MAX_UINT32) throw new Error('The extension is too large for a zip without Zip64');
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_BYTES);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
