import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Crx3Error, extensionId, verifyCrx3 } from './crx3.ts';
import type { Crx3Failure } from './crx3.ts';
import { crxIdBytes, packCrx3, spki } from './testing/pack-crx3.ts';
import type { Signer } from './testing/pack-crx3.ts';

/** Packed by Helium 0.21.1.1 (`--pack-extension`); Helium reported this ID when it installed them. */
const HELIUM_ID = 'gfekifbkhhkogkfncfemgflppbmlafic';
const ZIP_LOCAL_HEADER = Buffer.from('PK\x03\x04', 'latin1');

function fixture(name: string): Buffer {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url));
}

function flipBits(file: Buffer, offset: number, mask: number): void {
  file.writeUInt8(file.readUInt8(offset) ^ mask, offset);
}

function rsaSigner(extra: Partial<Signer> = {}): Signer {
  return { algorithm: 'rsa', ...generateKeyPairSync('rsa', { modulusLength: 2048 }), ...extra };
}

function ecdsaSigner(): Signer {
  return { algorithm: 'ecdsa', ...generateKeyPairSync('ec', { namedCurve: 'P-256' }) };
}

const archive = Buffer.concat([
  ZIP_LOCAL_HEADER,
  Buffer.from('not a real zip, the verifier never opens it'),
]);

function assertRefused(file: Uint8Array, reason: Crx3Failure): void {
  assert.throws(
    () => verifyCrx3(file),
    (error: unknown) => error instanceof Crx3Error && error.reason === reason,
  );
}

describe('verifyCrx3 on files packed by Helium', () => {
  it('derives the ID Helium reported', () => {
    const crx = verifyCrx3(fixture('helium-v1.crx'));
    assert.equal(crx.id, HELIUM_ID);
    assert.equal(extensionId(Buffer.from(crx.publicKey, 'base64')), HELIUM_ID);
    assert.deepEqual(Buffer.from(crx.archive.subarray(0, 4)), ZIP_LOCAL_HEADER);
  });

  it('gives a later version signed with the same key the same ID', () => {
    assert.equal(verifyCrx3(fixture('helium-v2.crx')).id, HELIUM_ID);
  });

  it('gives a file signed with another key a different ID', () => {
    assert.notEqual(verifyCrx3(fixture('helium-other-key.crx')).id, HELIUM_ID);
  });

  it('refuses a file whose archive was changed after signing', () => {
    const file = fixture('helium-v1.crx');
    flipBits(file, file.length - 10, 0xff);
    assertRefused(file, 'SIGNATURE_INVALID');
  });

  it('refuses a file whose declared ID was changed after signing', () => {
    const file = fixture('helium-v1.crx');
    const marker = file.indexOf(Buffer.from([0x82, 0xf1, 0x04]));
    assert.ok(marker > 0, 'signed_header_data field not found');
    // Key (3 bytes), length, SignedData key and length, then the first crx_id byte.
    flipBits(file, marker + 3 + 1 + 2, 0x01);
    assertRefused(file, 'SIGNATURE_INVALID');
  });
});

/**
 * Chromium's own test files (components/test/data/crx_file at revision
 * 7ff956173add630906515187ce16a956f0d2074e), with the IDs and keys its
 * crx_verifier_unittest.cc expects.
 */
describe('verifyCrx3 on Chromium’s test files', () => {
  const OJJ_ID = 'ojjgnpkioondelmggbekfhllhdaimnho';
  const OJJ_KEY =
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA230uN7vYDEhdDlb4/+pg2pfL8p0FFzCF/O146NB3D5dPKuLbnNphn0OUzOrDzR/Z1XLVDlDyiA6xnb+qeRp7H8n7Wk//gvVDNArZyForlVqWdaHLhl4dyZoNJwPKsggf30p/MxCbNfy2rzFujzn2nguOrJKzWvNt0BFqssrBpzOQl69blBezE2ZYGOnYW8mPgQV29ekIgOfJk2GgXoJBQQRRsjoPmUY7GDuEKudEB/CmWh3+mCsHBHFWbqtGhSN4YCAw3DYQzwdTcIVaIA8f2Uo4AZ4INKkrEPRL8o9mZDYtO2YHIQg8pMSRMa6AawBNYi9tZScnmgl5L1qE6z5oIwIDAQAB';
  const JLN_ID = 'jlnmailbicnpnbggmhfebbomaddckncf';

  it('accepts a file with only the developer’s signature', () => {
    const crx = verifyCrx3(fixture('chromium-valid_no_publisher.crx3'));
    assert.equal(crx.id, OJJ_ID);
    assert.equal(crx.publicKey, OJJ_KEY);
  });

  it('accepts a file that also carries Google’s publisher signature', () => {
    const crx = verifyCrx3(fixture('chromium-valid_publisher.crx3'));
    assert.equal(crx.id, OJJ_ID);
    assert.equal(crx.publicKey, OJJ_KEY);
  });

  it('accepts a file with the test publisher signature', () => {
    assert.equal(verifyCrx3(fixture('chromium-valid_test_publisher.crx3')).id, JLN_ID);
  });

  it('refuses a file with no developer signature', () => {
    assertRefused(fixture('chromium-unsigned.crx3'), 'REQUIRED_PROOF_MISSING');
  });

  it('refuses CRX2', () => {
    assertRefused(fixture('chromium-valid.crx2'), 'NOT_CRX3');
  });

  for (const [name, marker] of [
    ['EOCD', [0x05, 0x06]],
    ['Zip64 EOCD locator', [0x06, 0x07]],
    ['Zip64 EOCD record', [0x06, 0x06]],
  ] as const) {
    it(`refuses a header containing a zip ${name} signature`, () => {
      const file = fixture('chromium-valid_no_publisher.crx3');
      file.set([0x50, 0x4b, ...marker], 12);
      assertRefused(file, 'HEADER_INVALID');
    });
  }
});

describe('verifyCrx3 on crafted files', () => {
  it('accepts a file signed by its developer key', () => {
    const signer = rsaSigner();
    const crx = verifyCrx3(packCrx3({ archive, signers: [signer] }));
    assert.equal(crx.id, extensionId(spki(signer.publicKey)));
    assert.deepEqual(Buffer.from(crx.archive), archive);
  });

  it('accepts an ECDSA developer key', () => {
    const signer = ecdsaSigner();
    assert.equal(
      verifyCrx3(packCrx3({ archive, signers: [signer] })).id,
      extensionId(spki(signer.publicKey)),
    );
  });

  it('accepts an extra valid signature, such as Google’s, and keeps the developer’s ID', () => {
    const developer = rsaSigner();
    const crx = verifyCrx3(
      packCrx3({
        archive,
        signers: [rsaSigner(), developer],
        crxId: crxIdBytes(developer.publicKey),
      }),
    );
    assert.equal(crx.id, extensionId(spki(developer.publicKey)));
  });

  it('refuses a file when any signature is invalid, even an extra one', () => {
    assertRefused(
      packCrx3({ archive, signers: [rsaSigner(), rsaSigner({ corrupt: true })] }),
      'SIGNATURE_INVALID',
    );
  });

  it('refuses a validly signed file that claims another key’s ID', () => {
    const victim = rsaSigner();
    assertRefused(
      packCrx3({ archive, signers: [rsaSigner()], crxId: crxIdBytes(victim.publicKey) }),
      'REQUIRED_PROOF_MISSING',
    );
  });

  it('refuses a file with no signatures', () => {
    assertRefused(packCrx3({ archive, signers: [] }), 'REQUIRED_PROOF_MISSING');
  });

  it('refuses a key filed under the wrong algorithm', () => {
    const ec = ecdsaSigner();
    assertRefused(packCrx3({ archive, signers: [{ ...ec, algorithm: 'rsa' }] }), 'HEADER_INVALID');
  });

  it('refuses CRX2 and files that are not CRX at all', () => {
    assertRefused(packCrx3({ archive, signers: [rsaSigner()], version: 2 }), 'NOT_CRX3');
    assertRefused(archive, 'NOT_CRX3');
    assertRefused(Buffer.from('Cr24'), 'NOT_CRX3');
  });

  it('refuses a file with no archive', () => {
    assertRefused(
      packCrx3({ archive: Buffer.alloc(0), signers: [rsaSigner()] }),
      'ARCHIVE_MISSING',
    );
  });

  it('refuses a header that runs past the end of the file', () => {
    const file = packCrx3({ archive, signers: [rsaSigner()] });
    file.writeUInt32LE(file.length, 8);
    assertRefused(file, 'HEADER_INVALID');
  });

  it('refuses an oversized header', () => {
    const file = packCrx3({ archive, signers: [rsaSigner()] });
    file.writeUInt32LE(0xffffffff, 8);
    assertRefused(file, 'HEADER_INVALID');
  });

  it('refuses a header that is not valid protobuf', () => {
    const file = packCrx3({ archive, signers: [rsaSigner()] });
    file.fill(0xff, 12, 20);
    assertRefused(file, 'HEADER_INVALID');
  });
});
