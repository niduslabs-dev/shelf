/**
 * CRX3 verification, the way Chromium's `crx_file::Verify` does it for an
 * off-store install: every signature in the header must be valid, and one of
 * them must come from the key the extension ID is derived from. Google's
 * publisher proof is not required, which is what Helium's
 * `#extension-mime-request-handling` flag allows.
 *
 * File layout: "Cr24", uint32 LE version (3), uint32 LE header length, a
 * `CrxFileHeader` protobuf, then the zip archive. Every signature covers
 * "CRX3 SignedData\0", the uint32 LE length of `signed_header_data`, those
 * bytes, and the whole archive.
 *
 * Message definitions: chromium/src/components/crx_file/crx3.proto. The checks
 * follow chromium/src/components/crx_file/crx_verifier.cc.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { ProtobufError, bytesFields, readFields, singleBytesField } from './protobuf.ts';

const MAGIC = 'Cr24';
const CRX3_VERSION = 3;
const PREAMBLE_BYTES = 12;
const UINT32_BYTES = 4;
const SIGNATURE_CONTEXT = 'CRX3 SignedData\0';
/** Real headers are well under 2 KB (one RSA key and signature, maybe Google's too). */
const MAX_HEADER_BYTES = 64 * 1024;
const CRX_ID_BYTES = 16;
/**
 * Zip end-of-central-directory signatures (EOCD, Zip64 EOCD locator, Zip64
 * EOCD record). Chromium refuses a header containing any of them, so a zip
 * reader can't be tricked into reading a different archive from inside the
 * header than the one that was signed.
 */
const ZIP_END_MARKERS = [
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x06, 0x07]),
  Buffer.from([0x50, 0x4b, 0x06, 0x06]),
];

/** `CrxFileHeader` field numbers. */
const HEADER_SHA256_WITH_RSA = 2;
const HEADER_SHA256_WITH_ECDSA = 3;
const HEADER_SIGNED_HEADER_DATA = 10000;
/** `AsymmetricKeyProof` field numbers. */
const PROOF_PUBLIC_KEY = 1;
const PROOF_SIGNATURE = 2;
/** `SignedData` field numbers. */
const SIGNED_DATA_CRX_ID = 1;

/** Why a file was refused. The names match Chromium's `VerifierResult` where one exists. */
export type Crx3Failure =
  | 'NOT_CRX3'
  | 'HEADER_INVALID'
  | 'ARCHIVE_MISSING'
  | 'SIGNATURE_INVALID'
  | 'REQUIRED_PROOF_MISSING';

export class Crx3Error extends Error {
  override name = 'Crx3Error';
  readonly reason: Crx3Failure;
  constructor(reason: Crx3Failure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface VerifiedCrx {
  /** The 32-letter extension ID, derived from the developer's public key. */
  id: string;
  /** The developer's public key (DER SubjectPublicKeyInfo), base64, as a manifest's `key` field holds it. */
  publicKey: string;
  /** The zip archive with the extension's files. */
  archive: Uint8Array;
}

/**
 * The extension ID for a DER SubjectPublicKeyInfo: the first 16 bytes of its
 * SHA-256, written in hex with the digits 0–f replaced by the letters a–p.
 */
export function extensionId(spkiDer: Uint8Array): string {
  return idFromBytes(createHash('sha256').update(spkiDer).digest().subarray(0, CRX_ID_BYTES));
}

function idFromBytes(bytes: Uint8Array): string {
  const letterA = 'a'.charCodeAt(0);
  let id = '';
  for (const byte of bytes) {
    id += String.fromCharCode(letterA + (byte >> 4), letterA + (byte & 0xf));
  }
  return id;
}

interface Proof {
  algorithm: 'rsa' | 'ecdsa';
  publicKey: Uint8Array;
  signature: Uint8Array;
}

function readProofs(header: ReturnType<typeof readFields>): Proof[] {
  const proofs: Proof[] = [];
  const kinds = [
    ['rsa', HEADER_SHA256_WITH_RSA],
    ['ecdsa', HEADER_SHA256_WITH_ECDSA],
  ] as const;
  for (const [algorithm, fieldNumber] of kinds) {
    for (const raw of bytesFields(header, fieldNumber)) {
      const proof = readFields(raw);
      proofs.push({
        algorithm,
        publicKey: singleBytesField(proof, PROOF_PUBLIC_KEY),
        signature: singleBytesField(proof, PROOF_SIGNATURE),
      });
    }
  }
  return proofs;
}

function parsePublicKey(proof: Proof): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(proof.publicKey), format: 'der', type: 'spki' });
  } catch {
    throw new Crx3Error('HEADER_INVALID', 'A proof has a public key that is not valid DER');
  }
  const expected = proof.algorithm === 'rsa' ? 'rsa' : 'ec';
  if (key.asymmetricKeyType !== expected) {
    throw new Crx3Error(
      'HEADER_INVALID',
      `A ${proof.algorithm} proof holds a ${key.asymmetricKeyType} key`,
    );
  }
  return key;
}

/**
 * Verifies a CRX3 file and returns its ID, developer key and archive.
 * Throws `Crx3Error` for anything Chromium would refuse to install.
 * It does not look inside the archive.
 */
export function verifyCrx3(file: Uint8Array): VerifiedCrx {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (
    file.length < PREAMBLE_BYTES ||
    Buffer.from(file.subarray(0, MAGIC.length)).toString('latin1') !== MAGIC
  ) {
    throw new Crx3Error('NOT_CRX3', 'Not a CRX file');
  }
  const version = view.getUint32(MAGIC.length, true);
  if (version !== CRX3_VERSION)
    throw new Crx3Error('NOT_CRX3', `CRX version ${version}, expected 3`);

  const headerLength = view.getUint32(MAGIC.length + UINT32_BYTES, true);
  if (headerLength > MAX_HEADER_BYTES) throw new Crx3Error('HEADER_INVALID', 'Header too large');
  const archiveStart = PREAMBLE_BYTES + headerLength;
  if (archiveStart > file.length)
    throw new Crx3Error('HEADER_INVALID', 'Header runs past the end of the file');
  const headerBytes = Buffer.from(file.buffer, file.byteOffset + PREAMBLE_BYTES, headerLength);
  if (ZIP_END_MARKERS.some((marker) => headerBytes.includes(marker))) {
    throw new Crx3Error('HEADER_INVALID', 'The header contains a zip end-of-directory signature');
  }
  const archive = file.subarray(archiveStart);
  if (archive.length === 0) throw new Crx3Error('ARCHIVE_MISSING', 'No archive after the header');

  let proofs: Proof[];
  let signedHeaderData: Uint8Array;
  let declaredId: string;
  try {
    const header = readFields(headerBytes);
    proofs = readProofs(header);
    signedHeaderData = singleBytesField(header, HEADER_SIGNED_HEADER_DATA);
    const crxId = singleBytesField(readFields(signedHeaderData), SIGNED_DATA_CRX_ID);
    if (crxId.length !== CRX_ID_BYTES) throw new ProtobufError('crx_id must be 16 bytes');
    declaredId = idFromBytes(crxId);
  } catch (error) {
    if (error instanceof ProtobufError) throw new Crx3Error('HEADER_INVALID', error.message);
    throw error;
  }
  if (proofs.length === 0)
    throw new Crx3Error('REQUIRED_PROOF_MISSING', 'The header has no signatures');

  const lengthPrefix = Buffer.alloc(UINT32_BYTES);
  lengthPrefix.writeUInt32LE(signedHeaderData.length);
  const signedMessage = Buffer.concat([
    Buffer.from(SIGNATURE_CONTEXT, 'latin1'),
    lengthPrefix,
    signedHeaderData,
    archive,
  ]);

  let developerKey: Uint8Array | undefined;
  for (const proof of proofs) {
    const key = parsePublicKey(proof);
    if (!verify('sha256', signedMessage, key, proof.signature)) {
      throw new Crx3Error(
        'SIGNATURE_INVALID',
        `A ${proof.algorithm} signature does not match the file`,
      );
    }
    if (extensionId(proof.publicKey) === declaredId) developerKey = proof.publicKey;
  }
  if (developerKey === undefined) {
    throw new Crx3Error(
      'REQUIRED_PROOF_MISSING',
      `No signature from the key behind ID ${declaredId}`,
    );
  }

  return { id: declaredId, publicKey: Buffer.from(developerKey).toString('base64'), archive };
}
