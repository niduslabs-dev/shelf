/**
 * The store's HTML pages: the home page (a shell that `site/shelf.js` fills
 * from embedded JSON) and one server-rendered page per extension. Listing and
 * manifest text is untrusted, so every such string goes through `escapeHtml`
 * here, and through `textContent` in the browser.
 */
import type { Manifest } from './manifest.ts';
import { HIGH_REACH, REACH_LABELS, grants, reachLevel } from './reach.ts';
import type { ReachLevel, TrailChange } from './reach.ts';
import { REGISTRY_ORIGIN, REGISTRY_REPO } from './registry.ts';

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * JSON for a `<script type="application/json">` block. `<`, `>` and `&` are
 * written as Unicode escapes, so no listing text can close the script element.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "12 Nov 2026", from an ISO date or timestamp; empty when it can't be read. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

const KB = 1024;
const MB = KB * KB;

/** "48 KB" or "1.2 MB", with a non-breaking space. */
export function formatSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}&nbsp;MB`;
  return `${Math.max(1, Math.round(bytes / KB))}&nbsp;KB`;
}

/** The manifest's description, unless it's missing or a `__MSG_` placeholder for a translation. */
export function manifestDescription(manifest: Manifest): string | undefined {
  const { description } = manifest;
  if (typeof description !== 'string') return undefined;
  const trimmed = description.trim();
  if (trimmed === '' || trimmed.startsWith('__MSG_')) return undefined;
  return trimmed;
}

/** The letter tile's letter: the name's first character, upper-cased. */
export function initial(name: string): string {
  const [first = '?'] = name.trim();
  return first.toLocaleUpperCase('en');
}

const TEMPLATE_REPO = 'https://github.com/niduslabs-dev/shelf-extension-template';
const SOURCE_REPO = `https://github.com/${REGISTRY_REPO}`;

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff">
<title>${title}</title>
<link rel="preload" href="/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/shelf.css">
</head>
<body>`;
}

const LOGO = `<svg aria-hidden="true" width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="#17161C"/><rect x="7" y="8" width="3.5" height="10" rx="1" fill="#F6F6F8"/><rect x="12.25" y="6" width="3.5" height="12" rx="1" fill="#F6F6F8"/><rect x="18" y="9.5" width="3.5" height="8.5" rx="1" fill="#8DBB82" transform="rotate(-14 18 18)"/><rect x="6" y="19.5" width="16" height="2" rx="1" fill="#F6F6F8"/></svg>`;

const BAR = `<header class="bar">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Shelf home">
      ${LOGO}
      <span translate="no">Shelf</span>
    </a>
    <form class="search" role="search" action="/">
      <label class="search-field">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <span class="visually-hidden">Search extensions</span>
        <input id="q" name="q" type="search" placeholder="Search extensions…" autocomplete="off" spellcheck="false">
      </label>
    </form>
    <nav aria-label="For authors"><a href="${TEMPLATE_REPO}">List an extension</a></nav>
  </div>
</header>`;

const FOOTER_AND_DIALOG = `<footer>
  <div class="wrap">
    <span>Shelf keeps no record of who checks for updates. A Nidus Labs project, not affiliated with Google or the Helium team.</span>
    <nav aria-label="Registry data"><a href="/blocked.json">Blocked extensions</a><a href="/index.json" translate="no">index.json</a><a href="${SOURCE_REPO}">Source</a></nav>
  </div>
</footer>

<dialog id="setup" aria-labelledby="setup-title">
  <form method="dialog" class="dlg">
    <h2 id="setup-title">Allow installs from Shelf</h2>
    <p>Helium only installs from outside its own store once you switch this on. It takes a minute, once.</p>
    <ol class="steps">
      <li>Paste this into the address bar.
        <div class="copy-row"><code id="flag" translate="no">chrome://flags/<wbr>#extension-mime-request-handling</code><button class="btn" type="button" id="copy" autofocus>Copy</button></div>
        <span class="visually-hidden" id="copy-status" role="status"></span>
      </li>
      <li>Set it to <strong>Always prompt for install</strong>, then relaunch Helium.</li>
      <li>Press Install. Helium asks you to confirm.</li>
    </ol>
    <div class="dlg-actions">
      <button class="btn" value="cancel">Not now</button>
      <button class="install" value="done" id="dlg-go">Install</button>
    </div>
  </form>
</dialog>
<script src="/shelf.js"></script>
</body>
</html>
`;

/** The page for any address Shelf doesn't have, served with a 404 status. */
export function notFoundPage(): string {
  return `${head('Not on Shelf')}
<a class="skip" href="#main">Skip to the page</a>
${BAR}

<main class="wrap" id="main">
  <div class="empty-search not-found">
    <h1><strong>That page isn't on Shelf.</strong></h1>
    <p>The address may be mistyped, or the extension may no longer be listed. Extensions Shelf has blocked are on the <a href="/blocked.json">blocked list</a>.</p>
    <a class="btn btn-link" href="/">Show all extensions</a>
  </div>
</main>

${FOOTER_AND_DIALOG}`;
}

/** One extension as the home page's script sees it. */
export interface HomeItem {
  id: string;
  name: string;
  summary: string;
  author: string;
  version: string;
  /** When the current version was stored, as `YYYY-MM-DD`. */
  reviewed: string;
  reach: ReachLevel;
  /** True when `/icons/<id>.png` exists. */
  icon: boolean;
  /** The stored `.crx`. */
  crx: string;
}

/** The home page. The list, search and empty states are drawn by shelf.js from the `#data` JSON. */
export function homePage(items: HomeItem[]): string {
  return `${head('Shelf: extensions for Helium')}
<a class="skip" href="#main">Skip to extensions</a>
${BAR}

<main class="wrap" id="main">
  <div class="intro" id="intro">
    <p>Extensions for Helium, each signed by its author and reviewed before it reaches you.</p>
    <button class="setup-link" type="button" data-open-setup>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/></svg>
      Set up Helium for Shelf
    </button>
  </div>

  <div class="list-head">
    <h1 id="list-title">All extensions</h1>
    <span id="count" role="status"></span>
  </div>
  <ul class="rows" id="rows" role="list"></ul>
  <div class="empty-search" id="registry-empty" hidden>
    <p><strong>Nothing on Shelf yet.</strong></p>
    <p>Shelf is new. If you make an extension for Helium, you can be the first to list it. Your signing key stays yours, and a person reviews it.</p>
    <a class="btn btn-link" href="${TEMPLATE_REPO}">List an extension</a>
  </div>
  <div class="empty-search" id="none" hidden>
    <p><strong>Nothing on Shelf matches that yet.</strong></p>
    <p>Try a shorter word, or check the spelling. Looking for something Shelf doesn't have? <a href="${TEMPLATE_REPO}">Authors can list it here</a>.</p>
    <button class="btn" type="button" id="clear">Show all extensions</button>
  </div>
  <p class="install-status" id="install-status" role="status"></p>
</main>
<script type="application/json" id="data">${scriptJson(items)}</script>

${FOOTER_AND_DIALOG}`;
}

export interface TrailRow {
  version: string;
  /** ISO timestamp the stored Release was published. */
  date: string;
  change: TrailChange;
  /** The pull request that approved it, when one was found. */
  review?: number;
}

export interface ExtensionPageData {
  id: string;
  name: string;
  summary: string;
  author: string;
  repo: string;
  version: string;
  crx: string;
  size: number;
  icon: boolean;
  manifest: Manifest;
  /** Newest first. */
  trail: TrailRow[];
}

function iconTile(id: string, name: string, icon: boolean): string {
  return icon
    ? `<span class="icon" aria-hidden="true"><img src="/icons/${escapeHtml(id)}.png" alt=""></span>`
    : `<span class="icon" aria-hidden="true">${escapeHtml(initial(name))}</span>`;
}

function reachSection(manifest: Manifest): string {
  const level = reachLevel(manifest);
  const steps = [1, 2, 3, 4]
    .map((step) => (step <= level ? '<i class="on"></i>' : '<i></i>'))
    .join('');
  const labels = Object.values(REACH_LABELS)
    .map((label) => `<span>${label}</span>`)
    .join('');
  const rows = grants(manifest).map(
    (grant) =>
      `          <li${grant.high ? ' class="high"' : ''}><span>${escapeHtml(grant.label)}</span><code translate="no">${escapeHtml(grant.raw)}</code></li>`,
  );
  if (rows.length === 0) rows.push('          <li><span>Asks for no permissions</span></li>');
  return `      <section aria-labelledby="reach-title" class="reach-big">
        <h2 id="reach-title">What it can reach</h2>
        <span class="meter${level >= HIGH_REACH ? ' high' : ''}" aria-hidden="true">${steps}</span>
        <div class="meter-labels" aria-hidden="true">${labels}</div>
        <p class="visually-hidden">Reach: ${REACH_LABELS[level].toLowerCase()}, step ${level} of 4.</p>
        <ul class="grants" role="list">
${rows.join('\n')}
        </ul>
      </section>`;
}

function trailSection(trail: TrailRow[]): string {
  const rows = trail.map((row) => {
    const review =
      row.review === undefined
        ? ''
        : `<a href="${SOURCE_REPO}/pull/${row.review}">Review #${row.review}</a>`;
    return `            <tr><th scope="row" class="v">${escapeHtml(row.version)}</th><td class="d">${formatDate(row.date)}</td><td><span class="tag${row.change.adds ? ' high' : ''}">${escapeHtml(row.change.text)}</span></td><td>${review}</td></tr>`;
  });
  return `      <section aria-labelledby="trail-title">
        <h2 id="trail-title">Review trail</h2>
        <table class="trail">
          <caption class="visually-hidden">Every approved release, newest first</caption>
          <thead class="visually-hidden"><tr><th scope="col">Version</th><th scope="col">Approved</th><th scope="col">Permission change</th><th scope="col">Review</th></tr></thead>
          <tbody>
${rows.join('\n')}
          </tbody>
        </table>
      </section>`;
}

/** One extension's page, served at `/e/<id>`. Fully rendered here; shelf.js only adds the setup dialog. */
export function extensionPage(data: ExtensionPageData): string {
  const name = escapeHtml(data.name);
  const version = escapeHtml(data.version);
  const description = manifestDescription(data.manifest);
  const listed = data.trail.at(-1);
  const report = `${SOURCE_REPO}/issues/new?template=report-a-problem.yml&title=${encodeURIComponent(`Problem with ${data.id}`)}&extension=${encodeURIComponent(`${REGISTRY_ORIGIN}/e/${data.id}`)}`;
  return `${head(`${name} on Shelf`)}
<a class="skip" href="#main">Skip to the extension</a>
${BAR}

<main class="wrap" id="main">
  <nav class="crumb" aria-label="Breadcrumb"><a href="/">All extensions</a></nav>
  <div class="ext-head">
    ${iconTile(data.id, data.name, data.icon)}
    <div>
      <h1>${name}</h1>
      <p>By <a href="https://github.com/${escapeHtml(data.author)}">${escapeHtml(data.author)}</a>. <a href="${escapeHtml(data.repo)}">Source on GitHub</a>.</p>
    </div>
    <div class="act">
      <a class="install big" href="${escapeHtml(data.crx)}" data-install data-name="${name}" aria-label="Install ${name} ${version}">Install</a>
      <small>Version ${version}, ${formatSize(data.size)}</small>
    </div>
  </div>
  <p class="install-status" id="install-status" role="status"></p>

  <div class="ext-body">
    <div>
      <section>
        <p class="summary">${escapeHtml(data.summary)}</p>${description === undefined ? '' : `\n        <p class="prose">${escapeHtml(description)}</p>`}
      </section>

${reachSection(data.manifest)}

${trailSection(data.trail)}
    </div>

    <aside class="facts" aria-label="Details">
      <dl>
        <dt>Version</dt><dd>${version}</dd>
        <dt>Size</dt><dd>${formatSize(data.size)}</dd>
        <dt>Listed</dt><dd>${listed === undefined ? '' : formatDate(listed.date)}</dd>
        <dt>ID</dt><dd class="id" translate="no">${escapeHtml(data.id)}</dd>
      </dl>
      <p>The ID comes from the author's signing key. Helium refuses any update signed with a different key.</p>
      <p><a href="${escapeHtml(report)}">Report a problem</a></p>
    </aside>
  </div>
</main>

${FOOTER_AND_DIALOG}`;
}
