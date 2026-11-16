/**
 * Builds the static site served at `shelf.niduslabs.dev`: one update file per
 * extension (the URL baked into every listed extension), the store pages
 * (`index.html`, `e/<id>/index.html`, icons, and the static `shelf.css` and
 * `shelf.js` from `site/`), `index.json` for tools, `blocked.json` and
 * Cloudflare's `_headers`. It returns the files, and the caller writes them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Manifest } from './manifest.ts';
import { extensionPage, homePage } from './pages.ts';
import type { HomeItem, TrailRow } from './pages.ts';
import { readPermissions } from './permissions.ts';
import type { Permissions } from './permissions.ts';
import { reachLevel } from './reach.ts';
import type { ReachLevel } from './reach.ts';
import { approvedCrxUrl } from './registry.ts';
import type { Listing, Release } from './schema.ts';
import type { RegistryLists } from './standing.ts';

export interface SiteEntry {
  id: string;
  /** listed: in the index and updatable. left: its final release stays served, outside the index. */
  standing: 'listed' | 'left';
  listing: Listing;
  release: Release;
  manifest: Manifest;
  details: SiteDetails;
}

/** What publish gathers for the store pages, beyond the files in git. */
export interface SiteDetails {
  /** The stored `.crx`'s size in bytes. */
  size: number;
  /** The manifest's largest PNG icon, already checked by `extractIcon`. */
  icon?: Uint8Array;
  /** Every stored release, newest first; the first is the current one. */
  trail: TrailRow[];
}

export interface IndexEntry {
  id: string;
  name: string;
  summary: string;
  author: string;
  repo: string;
  version: string;
  crx: string;
  sha256: string;
  permissions: Permissions;
  reach: ReachLevel;
  /** Path of the icon on this site, when the extension has one. */
  icon: string | null;
  size: number;
  /** When the current version was stored (ISO timestamp). */
  reviewed: string;
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll("'", '&apos;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Chromium's update2 response. `hash_sha256` is included for browsers that
 * check it; Helium ignores it (tested), which is why the registry stores the
 * files itself.
 */
export function updateXml(
  id: string,
  update: { version: string; sha256: string } | 'noupdate',
): string {
  const check =
    update === 'noupdate'
      ? `<updatecheck status='noupdate' />`
      : `<updatecheck codebase='${xmlAttribute(approvedCrxUrl(id, update.version))}' version='${xmlAttribute(update.version)}' hash_sha256='${xmlAttribute(update.sha256)}' />`;
  return [
    `<?xml version='1.0' encoding='UTF-8'?>`,
    `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>`,
    `  <app appid='${xmlAttribute(id)}'>`,
    `    ${check}`,
    `  </app>`,
    `</gupdate>`,
    '',
  ].join('\n');
}

/**
 * Cloudflare's `_headers`. Update files, the index and the pages are cached
 * for five minutes at most, so a block or a new release reaches browsers
 * quickly. `Cache-Control` is set once, under `/*`, because Cloudflare joins
 * the values of a header that two matching rules set. The CSP allows only
 * this site's own script and styles, plus Google Fonts for Manrope.
 */
const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
  Cache-Control: public, max-age=300

/updates/*
  Content-Type: application/xml; charset=utf-8

/*.json
  Access-Control-Allow-Origin: *
`;

/** The browser files copied as they are: the store's styles and script. */
const STATIC_DIR = join(import.meta.dirname, '..', 'site');
const STATIC_ASSETS = ['shelf.css', 'shelf.js'];
/** `YYYY-MM-DD`, the date part of an ISO timestamp. */
const ISO_DATE_LENGTH = 10;

/** The home page's list: newest review first. */
function homeItems(index: IndexEntry[]): HomeItem[] {
  return index
    .toSorted((a, b) => b.reviewed.localeCompare(a.reviewed) || a.name.localeCompare(b.name))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      summary: entry.summary,
      author: entry.author,
      version: entry.version,
      reviewed: entry.reviewed.slice(0, ISO_DATE_LENGTH),
      reach: entry.reach,
      icon: entry.icon !== null,
      crx: entry.crx,
    }));
}

/**
 * Every file of the site, by path. Listed extensions are indexed and served.
 * One that left keeps its final release served, so older copies can follow it
 * out. Blocked and removed ones answer "no update". No ID that was ever listed
 * is left without an update file.
 */
export function buildSite(
  entries: SiteEntry[],
  lists: RegistryLists,
): Map<string, string | Uint8Array> {
  const files = new Map<string, string | Uint8Array>();
  const index: IndexEntry[] = [];
  const silenced = new Set([
    ...lists.blocklist.map((entry) => entry.id),
    ...lists.delisted.filter((entry) => entry.kind === 'removed').map((entry) => entry.id),
  ]);
  for (const { id, standing, listing, release, manifest, details } of entries.toSorted((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (silenced.has(id)) continue;
    files.set(`updates/${id}.xml`, updateXml(id, release));
    if (standing !== 'listed') continue;
    const icon = details.icon === undefined ? null : `icons/${id}.png`;
    if (details.icon !== undefined) files.set(`icons/${id}.png`, details.icon);
    const crx = approvedCrxUrl(id, release.version);
    files.set(
      `e/${id}/index.html`,
      extensionPage({
        id,
        ...listing,
        version: release.version,
        crx,
        size: details.size,
        icon: icon !== null,
        manifest,
        trail: details.trail,
      }),
    );
    index.push({
      id,
      name: listing.name,
      summary: listing.summary,
      author: listing.author,
      repo: listing.repo,
      version: release.version,
      crx,
      sha256: release.sha256,
      permissions: readPermissions(manifest),
      reach: reachLevel(manifest),
      icon,
      size: details.size,
      reviewed: details.trail.find((row) => row.version === release.version)?.date ?? '',
    });
  }
  for (const id of silenced) files.set(`updates/${id}.xml`, updateXml(id, 'noupdate'));
  files.set('index.json', `${JSON.stringify(index, null, 2)}\n`);
  files.set('blocked.json', `${JSON.stringify(lists.blocklist, null, 2)}\n`);
  files.set('index.html', homePage(homeItems(index)));
  for (const asset of STATIC_ASSETS)
    files.set(asset, readFileSync(join(STATIC_DIR, asset), 'utf8'));
  files.set('_headers', HEADERS);
  return files;
}
