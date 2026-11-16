/**
 * Writes CRX3 files: the inverse of `crx3.ts`. One RSA proof from the
 * developer key, and `signed_header_data` declaring the `crx_id` derived from
 * that key, which is the shape Chromium's own packer produces.
 *
 * RSA PKCS#1 v1.5 signatures are deterministic, so the same archive and key
 * always give the same bytes.
 */
import { createHash, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUE_BIT = 0x80;
const VARINT_PAYLOAD_BITS = 7;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_TYPE_BITS = 3;
const CRX_ID_BYTES = 16;
const UINT32_BYTES = 4;
const MAGIC = 'Cr24';
const CRX3_VERSION = 3;
const PREAMBLE_BYTES = 12;
export const SIGNATURE_CONTEXT = 'CRX3 SignedData\0';

/** `CrxFileHeader` field numbers. */
export const HEADER_SHA256_WITH_RSA = 2;
export const HEADER_SHA256_WITH_ECDSA = 3;
export const HEADER_SIGNED_HEADER_DATA = 10000;
/** `AsymmetricKeyProof` field numbers. */
export const PROOF_PUBLIC_KEY = 1;
export const PROOF_SIGNATURE = 2;
/** `SignedData` field numbers. */
export const SIGNED_DATA_CRX_ID = 1;

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > VARINT_PAYLOAD_MASK) {
    bytes.push((rest & VARINT_PAYLOAD_MASK) | VARINT_CONTINUE_BIT);
    rest = Math.floor(rest / 2 ** VARINT_PAYLOAD_BITS);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** One length-delimited protobuf field. */
export function bytesField(number: number, payload: Uint8Array): Buffer {
  return Buffer.concat([
    varint(number * 2 ** WIRE_TYPE_BITS + WIRE_LENGTH_DELIMITED),
    varint(payload.length),
    payload,
  ]);
}

/** A public key as DER SubjectPublicKeyInfo, the form CRX headers and extension IDs use. */
export function spki(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' });
}

/** The 16 bytes an extension ID is written from: the start of the key's SHA-256. */
export function crxIdBytes(publicKey: KeyObject): Buffer {
  return createHash('sha256').update(spki(publicKey)).digest().subarray(0, CRX_ID_BYTES);
}

/** The bytes every CRX3 signature covers. */
export function signedMessage(signedHeaderData: Uint8Array, archive: Uint8Array): Buffer {
  const length = Buffer.alloc(UINT32_BYTES);
  length.writeUInt32LE(signedHeaderData.length);
  return Buffer.concat([
    Buffer.from(SIGNATURE_CONTEXT, 'latin1'),
    length,
    signedHeaderData,
    archive,
  ]);
}

/** "Cr24", the format version and the header length, then the header and archive. */
export function assembleCrx(
  header: Uint8Array,
  archive: Uint8Array,
  version = CRX3_VERSION,
): Buffer {
  const preamble = Buffer.alloc(PREAMBLE_BYTES);
  preamble.write(MAGIC, 0, 'latin1');
  preamble.writeUInt32LE(version, MAGIC.length);
  preamble.writeUInt32LE(header.length, MAGIC.length + UINT32_BYTES);
  return Buffer.concat([preamble, header, archive]);
}

/** Signs `archive` with an RSA developer key and returns the `.crx` bytes. */
export function writeCrx3(
  archive: Uint8Array,
  privateKey: KeyObject,
  publicKey: KeyObject,
): Buffer {
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error(`The signing key must be RSA, not ${privateKey.asymmetricKeyType}`);
  }
  const signedHeaderData = bytesField(SIGNED_DATA_CRX_ID, crxIdBytes(publicKey));
  const signature = sign('sha256', signedMessage(signedHeaderData, archive), privateKey);
  const proof = Buffer.concat([
    bytesField(PROOF_PUBLIC_KEY, spki(publicKey)),
    bytesField(PROOF_SIGNATURE, signature),
  ]);
  const header = Buffer.concat([
    bytesField(HEADER_SHA256_WITH_RSA, proof),
    bytesField(HEADER_SIGNED_HEADER_DATA, signedHeaderData),
  ]);
  return assembleCrx(header, archive);
}
