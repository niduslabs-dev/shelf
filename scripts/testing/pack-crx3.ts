/**
 * A CRX3 writer for tests only. It builds well-formed and deliberately broken
 * files from keys made in the test, so the verifier can be tested against
 * cases a real packer would never produce. The production writer is
 * `crx3-write.ts`; real fixtures made by Helium live in `scripts/fixtures/`.
 */
import { sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import {
  HEADER_SHA256_WITH_ECDSA,
  HEADER_SHA256_WITH_RSA,
  HEADER_SIGNED_HEADER_DATA,
  PROOF_PUBLIC_KEY,
  PROOF_SIGNATURE,
  SIGNED_DATA_CRX_ID,
  assembleCrx,
  bytesField,
  crxIdBytes,
  signedMessage,
  spki,
} from '../crx3-write.ts';

export { crxIdBytes, spki };

const CRX_ID_BYTES = 16;

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

export function packCrx3({ archive, signers, crxId, version }: PackOptions): Buffer {
  const [first] = signers;
  const id = crxId ?? (first ? crxIdBytes(first.publicKey) : Buffer.alloc(CRX_ID_BYTES));
  const signedHeaderData = bytesField(SIGNED_DATA_CRX_ID, id);
  const message = signedMessage(signedHeaderData, archive);

  const proofs = signers.map((signer) => {
    const signed = signer.corrupt ? Buffer.concat([message, Buffer.from([0])]) : message;
    const signature = sign('sha256', signed, signer.privateKey);
    const proof = Buffer.concat([
      bytesField(PROOF_PUBLIC_KEY, spki(signer.publicKey)),
      bytesField(PROOF_SIGNATURE, signature),
    ]);
    return bytesField(
      signer.algorithm === 'rsa' ? HEADER_SHA256_WITH_RSA : HEADER_SHA256_WITH_ECDSA,
      proof,
    );
  });
  const header = Buffer.concat([
    ...proofs,
    bytesField(HEADER_SIGNED_HEADER_DATA, signedHeaderData),
  ]);
  return assembleCrx(header, archive, version);
}
