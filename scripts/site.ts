/**
 * Builds the static site served at `shelf.niduslabs.dev`: one update file per
 * extension (the URL baked into every listed extension), `index.json` for
 * tools, `blocked.json`, and a placeholder page until the index page is
 * designed. Pure: it returns the files, and the caller writes them.
 */
import type { Manifest } from './manifest.ts';
import { readPermissions } from './permissions.ts';
import type { Permissions } from './permissions.ts';
import { approvedCrxUrl } from './registry.ts';
import type { BlockedExtension, Listing, Release } from './schema.ts';

export interface SiteEntry {
  id: string;
  listing: Listing;
  release: Release;
  manifest: Manifest;
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

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shelf</title>
<p>Shelf is a registry of extensions for Helium and ungoogled-chromium. It isn't open yet.</p>
<p><a href="index.json">index.json</a> · <a href="https://github.com/niduslabs-dev/shelf">Source</a></p>
</html>
`;

/**
 * Every file of the site, by path. Blocked extensions get a "no update"
 * answer, so no further version reaches anyone, and leave the index.
 */
export function buildSite(
  entries: SiteEntry[],
  blocklist: BlockedExtension[],
): Map<string, string> {
  const files = new Map<string, string>();
  const blocked = new Set(blocklist.map((entry) => entry.id));
  const index: IndexEntry[] = [];
  for (const { id, listing, release, manifest } of entries.toSorted((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (blocked.has(id)) continue;
    files.set(`updates/${id}.xml`, updateXml(id, release));
    index.push({
      id,
      name: listing.name,
      summary: listing.summary,
      author: listing.author,
      repo: listing.repo,
      version: release.version,
      crx: approvedCrxUrl(id, release.version),
      sha256: release.sha256,
      permissions: readPermissions(manifest),
    });
  }
  for (const { id } of blocklist) files.set(`updates/${id}.xml`, updateXml(id, 'noupdate'));
  files.set('index.json', `${JSON.stringify(index, null, 2)}\n`);
  files.set('blocked.json', `${JSON.stringify(blocklist, null, 2)}\n`);
  files.set('index.html', PLACEHOLDER_PAGE);
  return files;
}
