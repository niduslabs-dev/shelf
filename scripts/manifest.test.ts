import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { verifyCrx3 } from './crx3.ts';
import {
  ManifestError,
  checkManifest,
  compareVersions,
  parseVersion,
  readManifest,
} from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { updateUrlFor } from './registry.ts';
import { writeZip } from './testing/write-zip.ts';
import { ZipError, readFile } from './zip.ts';

const ID = 'gfekifbkhhkogkfncfemgflppbmlafic';

function manifestZip(manifest: unknown, deflate = true): Buffer {
  return writeZip([{ name: 'manifest.json', content: JSON.stringify(manifest), deflate }]);
}

function refusesManifest(zip: Buffer): void {
  assert.throws(() => readManifest(zip), ManifestError);
}

function refuses(zip: Buffer): void {
  assert.throws(() => readFile(zip, 'manifest.json', 1024), ZipError);
}

function compare(a: string, b: string): number {
  return compareVersions(parseVersion(a)!, parseVersion(b)!);
}

function goodManifest(overrides: Manifest = {}): Manifest {
  return {
    manifest_version: 3,
    name: 'Example',
    version: '2.0',
    update_url: updateUrlFor(ID),
    ...overrides,
  };
}

describe('readManifest', () => {
  it('reads the manifest from a Helium-packed .crx', () => {
    const { archive } = verifyCrx3(
      readFileSync(new URL('fixtures/helium-v1.crx', import.meta.url)),
    );
    const manifest = readManifest(archive);
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.manifest_version, 3);
  });

  it('reads stored and deflated entries, and skips a UTF-8 BOM', () => {
    assert.equal(readManifest(manifestZip({ version: '1' }, false)).version, '1');
    assert.equal(readManifest(manifestZip({ version: '1' }, true)).version, '1');
    const withBom = writeZip([{ name: 'manifest.json', content: '﻿{"version":"3"}' }]);
    assert.equal(readManifest(withBom).version, '3');
  });

  it('refuses a missing, nested, non-JSON or non-object manifest', () => {
    refusesManifest(writeZip([{ name: 'readme.txt', content: 'hi' }]));
    refusesManifest(writeZip([{ name: 'src/manifest.json', content: '{}' }]));
    refusesManifest(writeZip([{ name: 'manifest.json', content: '{ // comment\n}' }]));
    refusesManifest(writeZip([{ name: 'manifest.json', content: '[]' }]));
  });
});

describe('zip reader refuses ambiguous or damaged archives', () => {
  it('two entries with the same name', () => {
    refuses(
      writeZip([
        { name: 'manifest.json', content: '{}' },
        { name: 'manifest.json', content: '{"evil":1}' },
      ]),
    );
  });

  it('names that differ only in case, which collide on Mac and Windows disks', () => {
    refuses(
      writeZip([
        { name: 'manifest.json', content: '{}' },
        { name: 'Manifest.JSON', content: '{"evil":1}' },
      ]),
    );
  });

  it('names that differ only in Unicode form', () => {
    refuses(
      writeZip([
        { name: 'café.js', content: '' },
        { name: 'café.js', content: '' },
        { name: 'manifest.json', content: '{}' },
      ]),
    );
  });

  it('a local header naming a different file', () => {
    refuses(writeZip([{ name: 'manifest.json', localName: 'other.json', content: '{}' }]));
  });

  it('a wrong CRC', () => {
    refuses(writeZip([{ name: 'manifest.json', content: '{}', crc: 1 }]));
  });

  it('encryption', () => {
    refuses(writeZip([{ name: 'manifest.json', content: '{}', encrypted: true }]));
  });

  it('a manifest over the size limit, even when it compresses well', () => {
    refuses(writeZip([{ name: 'manifest.json', content: ' '.repeat(4096), deflate: true }]));
  });

  it('something that is not a zip', () => {
    refuses(Buffer.from('not a zip at all, just some bytes'));
  });
});

describe('parseVersion and compareVersions', () => {
  it('accepts Chromium versions and refuses others', () => {
    assert.deepEqual(parseVersion('1.2.3.4'), [1, 2, 3, 4]);
    assert.deepEqual(parseVersion('0'), [0]);
    for (const bad of ['', '1.2.3.4.5', '01', '1.02', '1..2', '1.65536', '1.0-beta', ' 1', '1e3']) {
      assert.equal(parseVersion(bad), undefined, bad);
    }
  });

  it('compares numerically, with missing parts as 0', () => {
    assert.equal(compare('1.10', '1.9'), 1);
    assert.equal(compare('2.0', '2'), 0);
    assert.equal(compare('2.0.1', '2.0'), 1);
    assert.equal(compare('1.9.9', '2'), -1);
  });
});

describe('checkManifest', () => {
  it('passes a correct release', () => {
    assert.deepEqual(
      checkManifest(goodManifest(), { id: ID, version: '2.0', currentVersion: '1.9' }),
      [],
    );
  });

  it('flags MV2, a version mismatch and a wrong update_url, all at once', () => {
    const problems = checkManifest(
      goodManifest({
        manifest_version: 2,
        version: '2.1',
        update_url: 'https://example.com/u.xml',
      }),
      { id: ID, version: '2.0' },
    );
    assert.equal(problems.length, 3);
  });

  it('flags a version that is not higher than the current one', () => {
    assert.equal(
      checkManifest(goodManifest(), { id: ID, version: '2.0', currentVersion: '2.0.0' }).length,
      1,
    );
    assert.equal(
      checkManifest(goodManifest(), { id: ID, version: '2.0', currentVersion: '10.0' }).length,
      1,
    );
  });

  it('flags an invalid version', () => {
    assert.equal(
      checkManifest(goodManifest({ version: '2.0-beta' }), { id: ID, version: '2.0-beta' }).length,
      1,
    );
  });

  it('flags the Helium test fixture, which points at a localhost update server', () => {
    const { archive, id } = verifyCrx3(
      readFileSync(new URL('fixtures/helium-v1.crx', import.meta.url)),
    );
    const problems = checkManifest(readManifest(archive), { id, version: '1.0.0' });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /update_url/);
  });
});
