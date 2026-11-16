/**
 * A CRX3 writer for tests only. It builds well-formed and deliberately broken
 * files from keys made in the test, so the verifier can be tested against
 * cases Helium's packer would never produce. Real fixtures made by Helium live
 * in `scripts/fixtures/`.
 */
import { createHash, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUE_BIT = 0x80;
const VARINT_PAYLOAD_BITS = 7;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_TYPE_BITS = 3;
const CRX_ID_BYTES = 16;

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

function bytesField(number: number, payload: Uint8Array): Buffer {
  return Buffer.concat([
    varint(number * 2 ** WIRE_TYPE_BITS + WIRE_LENGTH_DELIMITED),
    varint(payload.length),
    payload,
  ]);
}

export function spki(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' });
}

export function crxIdBytes(publicKey: KeyObject): Buffer {
  return createHash('sha256').update(spki(publicKey)).digest().subarray(0, CRX_ID_BYTES);
}

export interface Signer {
  algorithm: 'rsa' | 'ecdsa';
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Sign something other than the real message, to make an invalid signature. */
  corrupt?: boolean;
}

export interface PackOptions {
  archive: Uint8Array;
  signers: Signer[];
  /** The 16-byte crx_id to declare; defaults to the first signer's. */
  crxId?: Uint8Array;
  version?: number;
}

export function packCrx3({ archive, signers, crxId, version = 3 }: PackOptions): Buffer {
  const [first] = signers;
  const id = crxId ?? (first ? crxIdBytes(first.publicKey) : Buffer.alloc(CRX_ID_BYTES));
  const signedHeaderData = bytesField(1, id);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const message = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'latin1'),
    length,
    signedHeaderData,
    archive,
  ]);

  const proofs = signers.map((signer) => {
    const signed = signer.corrupt ? Buffer.concat([message, Buffer.from([0])]) : message;
    const signature = sign('sha256', signed, signer.privateKey);
    const proof = Buffer.concat([bytesField(1, spki(signer.publicKey)), bytesField(2, signature)]);
    return bytesField(signer.algorithm === 'rsa' ? 2 : 3, proof);
  });
  const header = Buffer.concat([...proofs, bytesField(10000, signedHeaderData)]);

  const preamble = Buffer.alloc(12);
  preamble.write('Cr24', 0, 'latin1');
  preamble.writeUInt32LE(version, 4);
  preamble.writeUInt32LE(header.length, 8);
  return Buffer.concat([preamble, header, archive]);
}
