/** A zip writer for tests only, able to make archives the reader must refuse. */
import { crc32, deflateRawSync } from 'node:zlib';

export interface TestEntry {
  name: string;
  content: string | Buffer;
  deflate?: boolean;
  /** Name written in the local header, when it should differ from the central directory's. */
  localName?: string;
  /** CRC to record instead of the real one. */
  crc?: number;
  encrypted?: boolean;
}

export function writeZip(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const data = entry.deflate ? deflateRawSync(content) : content;
    const method = entry.deflate ? 8 : 0;
    const crc = entry.crc ?? crc32(content);
    const flags = entry.encrypted ? 1 : 0;
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(localName.length, 26);
    locals.push(local, localName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + localName.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
