import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_ICON_BYTES, extractIcon, iconPaths } from './icon.ts';
import { writeZip } from './testing/write-zip.ts';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (marker: string) => Buffer.concat([PNG_HEADER, Buffer.from(marker)]);

describe('iconPaths', () => {
  it('orders PNG icons largest first and skips other formats', () => {
    assert.deepEqual(
      iconPaths({
        icons: { '16': 'i/16.png', '128': '/i/128.PNG', '48': 'i/48.png', '256': 'i/256.svg' },
      }),
      ['i/128.PNG', 'i/48.png', 'i/16.png'],
    );
    assert.deepEqual(iconPaths({}), []);
    assert.deepEqual(iconPaths({ icons: ['a.png'] }), []);
  });
});

describe('extractIcon', () => {
  const manifest = { icons: { '16': 'icons/16.png', '128': 'icons/128.png' } };

  it('extracts the largest PNG icon', () => {
    const archive = writeZip([
      { name: 'icons/16.png', content: png('small') },
      { name: 'icons/128.png', content: png('large'), deflate: true },
    ]);
    assert.deepEqual(extractIcon(archive, manifest), png('large'));
  });

  it('falls back to a smaller icon when the largest is missing, not a PNG or too big', () => {
    const small = { name: 'icons/16.png', content: png('small') };
    assert.deepEqual(extractIcon(writeZip([small]), manifest), png('small'));
    assert.deepEqual(
      extractIcon(writeZip([small, { name: 'icons/128.png', content: '<svg/>' }]), manifest),
      png('small'),
    );
    const huge = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_ICON_BYTES)]);
    assert.deepEqual(
      extractIcon(writeZip([small, { name: 'icons/128.png', content: huge }]), manifest),
      png('small'),
    );
  });

  it('returns nothing without a usable icon', () => {
    assert.equal(extractIcon(writeZip([{ name: 'a.txt', content: 'x' }]), manifest), undefined);
    assert.equal(extractIcon(writeZip([{ name: 'a.txt', content: 'x' }]), {}), undefined);
    assert.equal(
      extractIcon(writeZip([{ name: 'icons/128.png', content: png('x'), crc: 1 }]), {
        icons: { '128': 'icons/128.png' },
      }),
      undefined,
    );
  });
});
