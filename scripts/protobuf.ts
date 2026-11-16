/**
 * A minimal protobuf reader: just enough to walk the messages in a CRX3 header.
 * It reads every field into a list, keeps length-delimited values as raw bytes,
 * and rejects anything malformed rather than guessing.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const FIXED64_BYTES = 8;
const FIXED32_BYTES = 4;
const VARINT_PAYLOAD_BITS = 7;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUE_BIT = 0x80;
const WIRE_TYPE_BITS = 3;
const WIRE_TYPE_MASK = 0b111;
/** Longer than any varint this reader accepts (2^53 fits in 8 bytes). */
const MAX_VARINT_BYTES = 8;

export class ProtobufError extends Error {
  override name = 'ProtobufError';
}

export interface Field {
  number: number;
  /** The payload of a length-delimited field; `undefined` for the other wire types, which CRX3 doesn't use. */
  bytes: Uint8Array | undefined;
}

function readVarint(buf: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let multiplier = 1;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    const byte = buf[start + i];
    if (byte === undefined) throw new ProtobufError('Truncated varint');
    value += (byte & VARINT_PAYLOAD_MASK) * multiplier;
    if ((byte & VARINT_CONTINUE_BIT) === 0) {
      if (!Number.isSafeInteger(value)) throw new ProtobufError('Varint too large');
      return { value, next: start + i + 1 };
    }
    multiplier *= 2 ** VARINT_PAYLOAD_BITS;
  }
  throw new ProtobufError('Varint too long');
}

/** Reads every top-level field of one message, in order. Repeated fields appear once per value. */
export function readFields(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.next;
    const number = Math.floor(key.value / 2 ** WIRE_TYPE_BITS);
    const wireType = key.value & WIRE_TYPE_MASK;
    if (number === 0) throw new ProtobufError('Field number 0');

    switch (wireType) {
      case WIRE_VARINT: {
        pos = readVarint(buf, pos).next;
        fields.push({ number, bytes: undefined });
        break;
      }
      case WIRE_FIXED64:
      case WIRE_FIXED32: {
        pos += wireType === WIRE_FIXED64 ? FIXED64_BYTES : FIXED32_BYTES;
        if (pos > buf.length) throw new ProtobufError('Truncated fixed-width field');
        fields.push({ number, bytes: undefined });
        break;
      }
      case WIRE_LENGTH_DELIMITED: {
        const length = readVarint(buf, pos);
        const end = length.next + length.value;
        if (end > buf.length) throw new ProtobufError('Length-delimited field runs past the end');
        fields.push({ number, bytes: buf.subarray(length.next, end) });
        pos = end;
        break;
      }
      default:
        throw new ProtobufError(`Unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

/** The payloads of every length-delimited field with this number. */
export function bytesFields(fields: Field[], number: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const field of fields) {
    if (field.number !== number) continue;
    if (field.bytes === undefined)
      throw new ProtobufError(`Field ${number} isn't length-delimited`);
    out.push(field.bytes);
  }
  return out;
}

/** The payload of a field that must appear exactly once. */
export function singleBytesField(fields: Field[], number: number): Uint8Array {
  const values = bytesFields(fields, number);
  const [value] = values;
  if (value === undefined || values.length !== 1) {
    throw new ProtobufError(`Expected field ${number} exactly once, found ${values.length}`);
  }
  return value;
}
