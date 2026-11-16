import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { HomeItem } from './pages.ts';
import { approvedCrxUrl } from './registry.ts';
import { buildSite, updateXml } from './site.ts';
import type { IndexEntry, SiteDetails, SiteEntry } from './site.ts';
import type { RegistryLists } from './standing.ts';

const ID = 'a'.repeat(32);
const BLOCKED = 'b'.repeat(32);
const LEFT = 'c'.repeat(32);
const REMOVED = 'd'.repeat(32);
const HOSTILE = '<img src=x onerror=alert(1)>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const none: RegistryLists = { blocklist: [], delisted: [] };

const details = (date = '2026-11-12T10:00:00Z', extra: Partial<SiteDetails> = {}): SiteDetails => ({
  size: 48 * 1024,
  trail: [{ version: '1.2', date, change: { text: 'Listed', adds: false }, review: 7 }],
  ...extra,
});

const entry = (
  id: string,
  standing: SiteEntry['standing'] = 'listed',
  overrides: Partial<SiteEntry> = {},
): SiteEntry => ({
  id,
  standing,
  listing: {
    name: 'Example',
    summary: 'Does a thing.',
    author: 'alice',
    repo: 'https://github.com/alice/example',
  },
  release: {
    version: '1.2',
    crx: 'https://github.com/alice/example/releases/download/v1.2/e.crx',
    sha256: 'f'.repeat(64),
  },
  manifest: { permissions: ['storage'] },
  details: details(),
  ...overrides,
});

function text(files: Map<string, string | Uint8Array>, path: string): string {
  const file = files.get(path);
  assert.equal(typeof file, 'string', `${path} is a text file`);
  return file as string;
}

/** The JSON the home page's script reads. */
function homeData(files: Map<string, string | Uint8Array>): HomeItem[] {
  const match = /<script type="application\/json" id="data">(.*?)<\/script>/s.exec(
    text(files, 'index.html'),
  );
  assert.ok(match?.[1] !== undefined);
  return JSON.parse(match[1]) as HomeItem[];
}

/** A valid extension ID (letters a to p) for each number. */
function idOf(index: number): string {
  return index
    .toString(16)
    .padStart(32, '0')
    .replaceAll(/[0-9a-f]/g, (digit) =>
      String.fromCodePoint('a'.charCodeAt(0) + Number.parseInt(digit, 16)),
    );
}

describe('updateXml', () => {
  it('points the update at the stored copy, with its hash', () => {
    const xml = updateXml(ID, { version: '1.2', sha256: 'f'.repeat(64) });
    assert.match(xml, new RegExp(`<app appid='${ID}'>`));
    assert.match(
      xml,
      new RegExp(`codebase='${approvedCrxUrl(ID, '1.2')}' version='1.2' hash_sha256='f{64}'`),
    );
  });

  it('escapes attribute values', () => {
    assert.match(updateXml(ID, { version: `1'<&`, sha256: 'x' }), /version='1&apos;&lt;&amp;'/);
  });

  it('answers "no update" for a blocked extension', () => {
    assert.match(updateXml(ID, 'noupdate'), /<updatecheck status='noupdate' \/>/);
  });
});

describe('buildSite', () => {
  const files = buildSite([entry(ID), entry(BLOCKED), entry(LEFT, 'left')], {
    blocklist: [{ id: BLOCKED, reason: 'Malware', date: '2026-11-16' }],
    delisted: [
      { id: LEFT, kind: 'left', reason: 'Moved', date: '2026-11-16' },
      { id: REMOVED, kind: 'removed', reason: 'Asked', date: '2026-11-16' },
    ],
  });

  it('writes an update file for every listed and blocked extension', () => {
    assert.match(text(files, `updates/${ID}.xml`), /version='1\.2'/);
    assert.match(text(files, `updates/${BLOCKED}.xml`), /noupdate/);
  });

  it('keeps serving the final release of one that left, outside the index, and silences removed ones', () => {
    assert.match(text(files, `updates/${LEFT}.xml`), /version='1\.2'/);
    assert.match(text(files, `updates/${REMOVED}.xml`), /noupdate/);
    assert.equal(files.has(`e/${LEFT}/index.html`), false);
  });

  it('keeps blocked extensions out of index.json and lists them in blocked.json', () => {
    const index = JSON.parse(text(files, 'index.json')) as IndexEntry[];
    assert.deepEqual(
      index.map((item) => item.id),
      [ID],
    );
    const [first] = index;
    assert.ok(first);
    assert.deepEqual(first.permissions.permissions, ['storage']);
    assert.equal(first.crx, approvedCrxUrl(ID, '1.2'));
    assert.equal(first.reach, 1);
    assert.equal(first.size, 48 * 1024);
    assert.equal(first.reviewed, '2026-11-12T10:00:00Z');
    assert.equal(first.icon, null);
    assert.match(text(files, 'blocked.json'), /Malware/);
    assert.equal(files.has(`e/${BLOCKED}/index.html`), false);
  });

  it('caches everything for five minutes at most, and serves update files as XML', () => {
    const headers = text(files, '_headers');
    assert.match(headers, /^\/\*\n(?: {2}.+\n)* {2}Cache-Control: public, max-age=300\n/);
    assert.match(headers, /\/updates\/\*\n {2}Content-Type: application\/xml; charset=utf-8\n/);
    assert.equal(headers.match(/Cache-Control/g)?.length, 1);
  });

  it('locks the pages down to their own script, styles and fonts', () => {
    assert.match(
      text(files, '_headers'),
      / {2}Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'\n/,
    );
  });

  it('self-hosts Manrope, so no page view reaches a third party', () => {
    for (const font of ['fonts/manrope-latin.woff2', 'fonts/manrope-latin-ext.woff2']) {
      const bytes = files.get(font);
      assert.ok(bytes instanceof Uint8Array, font);
      assert.equal(Buffer.from(bytes.subarray(0, 4)).toString('latin1'), 'wOF2');
    }
    assert.match(text(files, 'fonts/OFL.txt'), /SIL Open Font License/);
    assert.match(text(files, 'shelf.css'), /src: url\('\/fonts\/manrope-latin\.woff2'\)/);
    for (const page of ['index.html', `e/${ID}/index.html`, '404.html']) {
      assert.doesNotMatch(text(files, page), /googleapis|gstatic/);
      assert.match(text(files, page), /rel="preload" href="\/fonts\/manrope-latin\.woff2"/);
    }
  });

  it('has a 404 page in the store’s look', () => {
    const page = text(files, '404.html');
    assert.match(page, /That page isn't on Shelf\./);
    assert.match(page, /<a class="btn btn-link" href="\/">Show all extensions<\/a>/);
    assert.match(page, /<link rel="stylesheet" href="\/shelf\.css">/);
  });

  it('copies the store styles and script, and every page loads them from the root', () => {
    assert.match(text(files, 'shelf.css'), /--moss:/);
    assert.match(text(files, 'shelf.js'), /getElementById\('data'\)/);
    for (const page of ['index.html', `e/${ID}/index.html`]) {
      assert.match(text(files, page), /<link rel="stylesheet" href="\/shelf\.css">/);
      assert.match(text(files, page), /<script src="\/shelf\.js"><\/script>/);
      assert.doesNotMatch(text(files, page), /<script>|style="|\son[a-z]+=/);
    }
  });

  it('writes an extension page with an Install link to the stored copy', () => {
    const page = text(files, `e/${ID}/index.html`);
    assert.match(page, /<title>Example on Shelf<\/title>/);
    assert.match(
      page,
      new RegExp(`<a class="install big" href="${approvedCrxUrl(ID, '1.2')}" data-install`),
    );
    assert.match(page, /Version 1\.2, 48&nbsp;KB/);
    assert.match(page, /<dt>Listed<\/dt><dd>12 Nov 2026<\/dd>/);
    assert.match(page, /<form class="search" role="search" action="\/">/);
    assert.match(page, /<dialog id="setup"/);
  });
});

describe('the home page', () => {
  it('shows the empty registry with no listings', () => {
    const files = buildSite([], none);
    assert.deepEqual(homeData(files), []);
    assert.match(text(files, 'index.html'), /id="registry-empty" hidden/);
    assert.equal(
      [...files.keys()].some((path) => path.startsWith('e/')),
      false,
    );
  });

  it('lists a few extensions, newest review first', () => {
    const files = buildSite(
      [
        entry(ID, 'listed', { details: details('2026-10-01T00:00:00Z') }),
        entry(LEFT, 'listed', { details: details('2026-11-15T00:00:00Z') }),
        entry(REMOVED, 'listed', { details: details('2026-11-02T00:00:00Z') }),
      ],
      none,
    );
    const items = homeData(files);
    assert.deepEqual(
      items.map((item) => [item.id, item.reviewed]),
      [
        [LEFT, '2026-11-15'],
        [REMOVED, '2026-11-02'],
        [ID, '2026-10-01'],
      ],
    );
    assert.deepEqual(items[0], {
      id: LEFT,
      name: 'Example',
      summary: 'Does a thing.',
      author: 'alice',
      version: '1.2',
      reviewed: '2026-11-15',
      reach: 1,
      icon: false,
      crx: approvedCrxUrl(LEFT, '1.2'),
    });
  });

  it('lists many extensions, each with its own page', () => {
    const count = 120;
    const entries = Array.from({ length: count }, (_, index) => entry(idOf(index)));
    const files = buildSite(entries, none);
    assert.equal(homeData(files).length, count);
    assert.equal(
      [...files.keys()].filter((path) => /^e\/[a-p]{32}\/index\.html$/.test(path)).length,
      count,
    );
  });
});

describe('icons', () => {
  it('writes the icon and shows it, or falls back to the letter tile', () => {
    const withIcon = buildSite(
      [entry(ID, 'listed', { details: details(undefined, { icon: PNG }) })],
      none,
    );
    assert.deepEqual(withIcon.get(`icons/${ID}.png`), PNG);
    assert.match(
      text(withIcon, `e/${ID}/index.html`),
      new RegExp(
        `<span class="icon" aria-hidden="true"><img src="/icons/${ID}.png" alt=""></span>`,
      ),
    );
    assert.equal(homeData(withIcon)[0]?.icon, true);

    const without = buildSite([entry(ID)], none);
    assert.equal(without.has(`icons/${ID}.png`), false);
    assert.match(
      text(without, `e/${ID}/index.html`),
      /<span class="icon" aria-hidden="true">E<\/span>/,
    );
  });
});

/** The extension page for a manifest with this description. */
function described(description: unknown): string {
  return text(
    buildSite([entry(ID, 'listed', { manifest: { description } })], none),
    `e/${ID}/index.html`,
  );
}

describe('the extension page', () => {
  it('shows the manifest description, unless it is a translation placeholder', () => {
    assert.match(
      described('Reads articles aloud.'),
      /<p class="prose">Reads articles aloud\.<\/p>/,
    );
    assert.doesNotMatch(described('__MSG_appDesc__'), /class="prose"/);
    assert.doesNotMatch(described(undefined), /class="prose"/);
  });

  it('shows the reach meter and every permission in plain words', () => {
    const page = text(
      buildSite(
        [
          entry(ID, 'listed', {
            manifest: {
              permissions: ['storage', 'someNewApi'],
              host_permissions: ['<all_urls>'],
              optional_permissions: ['clipboardRead'],
            },
          }),
        ],
        none,
      ),
      `e/${ID}/index.html`,
    );
    assert.match(
      page,
      /<span class="meter high" aria-hidden="true"><i class="on"><\/i><i class="on"><\/i><i class="on"><\/i><i><\/i><\/span>/,
    );
    assert.match(page, /Reach: all sites, step 3 of 4\./);
    assert.match(
      page,
      /<li class="high"><span>Read and change every site you visit<\/span><code translate="no">host_permissions: &lt;all_urls&gt;<\/code><\/li>/,
    );
    assert.match(
      page,
      /<li><span>someNewApi<\/span><code translate="no">permissions: someNewApi<\/code><\/li>/,
    );
    assert.match(page, /<li><span>Can ask for: Read your clipboard<\/span>/);
  });

  it('shows the review trail, newest first, with amber for added access', () => {
    const page = text(
      buildSite(
        [
          entry(ID, 'listed', {
            details: {
              size: 2_500_000,
              trail: [
                {
                  version: '1.2',
                  date: '2026-11-12T00:00:00Z',
                  change: { text: 'Added access to all sites', adds: true },
                  review: 14,
                },
                {
                  version: '1.0',
                  date: '2026-10-10T00:00:00Z',
                  change: { text: 'Listed', adds: false },
                },
              ],
            },
          }),
        ],
        none,
      ),
      `e/${ID}/index.html`,
    );
    assert.match(
      page,
      /<th scope="row" class="v">1\.2<\/th><td class="d">12 Nov 2026<\/td><td><span class="tag high">Added access to all sites<\/span><\/td><td><a href="https:\/\/github\.com\/niduslabs-dev\/shelf\/pull\/14">Review #14<\/a><\/td>/,
    );
    assert.match(
      page,
      /class="v">1\.0<\/th><td class="d">10 Oct 2026<\/td><td><span class="tag">Listed<\/span><\/td><td><\/td>/,
    );
    assert.match(page, /<dt>Listed<\/dt><dd>10 Oct 2026<\/dd>/);
    assert.match(page, /Version 1\.2, 2\.4&nbsp;MB/);
  });
});

describe('untrusted listing text', () => {
  const files = buildSite(
    [
      entry(ID, 'listed', {
        listing: {
          name: HOSTILE,
          summary: `</script><script>alert(1)</script>`,
          author: 'alice',
          repo: 'https://github.com/alice/example',
        },
        manifest: { description: HOSTILE, host_permissions: [`https://"><b>x</b>/*`] },
      }),
    ],
    none,
  );

  it('comes out inert on the extension page', () => {
    const page = text(files, `e/${ID}/index.html`);
    assert.doesNotMatch(page, /<img src=x|<script>alert|<b>x/);
    assert.match(page, /<h1>&lt;img src=x onerror=alert\(1\)&gt;<\/h1>/);
    assert.match(page, /<title>&lt;img src=x onerror=alert\(1\)&gt; on Shelf<\/title>/);
    assert.match(page, /data-name="&lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.match(page, /<span class="icon" aria-hidden="true">&lt;<\/span>/);
  });

  it('stays inside the home page JSON, which the script only renders as text', () => {
    const page = text(files, 'index.html');
    assert.doesNotMatch(page, /<img src=x|<\/script><script>alert/);
    assert.equal(homeData(files)[0]?.name, HOSTILE);
    const script = readFileSync(join(import.meta.dirname, '..', 'site', 'shelf.js'), 'utf8');
    assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
});
