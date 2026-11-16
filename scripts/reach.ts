/**
 * What an extension can reach, in plain words for the store pages: one of
 * four reach levels, each grant as a sentence with its raw manifest key, and
 * how a release changed access, for the review trail. Pure; the manifest
 * strings it returns are untrusted and must be escaped by the caller.
 */
import type { Manifest } from './manifest.ts';
import { diffRelease, readPermissions } from './permissions.ts';
import type { PermissionKind } from './permissions.ts';

/** 1 own data, 2 some sites, 3 all sites, 4 your browser. */
export type ReachLevel = 1 | 2 | 3 | 4;

export const REACH_LABELS: Record<ReachLevel, string> = {
  1: 'Own data',
  2: 'Some sites',
  3: 'All sites',
  4: 'Your browser',
};

/** Levels at or above this are shown in amber. */
export const HIGH_REACH: ReachLevel = 3;

/** API permissions that reach into the browser itself: your tabs, history, traffic or other apps. */
const BROWSER_PERMISSIONS = new Set([
  'tabs',
  'history',
  'cookies',
  'webRequest',
  'webRequestBlocking',
  'downloads',
  'management',
  'debugger',
  'proxy',
  'privacy',
  'browsingData',
  'bookmarks',
  'topSites',
  'webNavigation',
  'nativeMessaging',
  'clipboardRead',
  'desktopCapture',
  'tabCapture',
  'pageCapture',
  'contentSettings',
  'declarativeNetRequestFeedback',
]);

/** Plain words for the common API permissions. Anything else shows its raw name. */
const PERMISSION_LABELS: Record<string, string> = {
  activeTab: 'Act on the current tab when you use it',
  alarms: 'Run tasks on a schedule',
  bookmarks: 'Read and change your bookmarks',
  browsingData: 'Clear your browsing data',
  clipboardRead: 'Read your clipboard',
  clipboardWrite: 'Copy to your clipboard',
  contentSettings: 'Change site settings like camera and cookies',
  contextMenus: 'Add items to the right-click menu',
  cookies: 'Read and change cookies',
  debugger: 'Debug pages and see everything on them',
  declarativeNetRequest: 'Block or change requests by rules',
  declarativeNetRequestFeedback: 'See which requests its rules matched',
  declarativeNetRequestWithHostAccess: 'Block or change requests by rules',
  desktopCapture: 'Capture your screen',
  downloads: 'Manage your downloads',
  geolocation: 'Know your location',
  history: 'Read and change your browsing history',
  identity: 'Sign you in with your accounts',
  idle: 'Know when you are away',
  management: 'Manage your other extensions',
  nativeMessaging: 'Talk to apps on your computer',
  notifications: 'Show notifications',
  offscreen: 'Use hidden pages for background work',
  pageCapture: 'Save pages as files',
  power: 'Keep your computer awake',
  privacy: 'Change your privacy settings',
  proxy: 'Control your proxy settings',
  scripting: 'Run scripts on sites it can reach',
  search: 'Search with your default search engine',
  sessions: 'See recently closed tabs',
  sidePanel: 'Show a side panel',
  storage: 'Store its own data',
  tabCapture: 'Capture what plays in a tab',
  tabGroups: 'Organise your tab groups',
  tabs: 'See your tabs and their addresses',
  topSites: 'See your most visited sites',
  unlimitedStorage: 'Store a lot of its own data',
  webNavigation: 'See every page you open',
  webRequest: 'See your traffic to sites it can reach',
  webRequestBlocking: 'Block or change your traffic',
};

const ALL_SITES_PATTERNS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);

/** True for a match pattern that covers every site: `<all_urls>` or any pattern whose host is `*`. */
export function coversAllSites(pattern: string): boolean {
  if (ALL_SITES_PATTERNS.has(pattern)) return true;
  const match = /^[^:/]+:\/\/([^/]*)/.exec(pattern);
  return match?.[1] === '*';
}

/** The extension's reach. Optional permissions don't count: the browser asks before granting them. */
export function reachLevel(manifest: Manifest): ReachLevel {
  const granted = readPermissions(manifest);
  if (granted.permissions.some((name) => BROWSER_PERMISSIONS.has(name))) return 4;
  const sites = [...granted.host_permissions, ...granted.content_scripts];
  if (sites.some(coversAllSites)) return 3;
  if (sites.length > 0) return 2;
  return 1;
}

/** The kinds that name browser APIs; the others name sites. */
const API_KINDS = new Set<PermissionKind>(['permissions', 'optional_permissions']);

/** A permission's own reach, which decides whether its row is amber. */
function grantLevel(kind: PermissionKind, value: string): ReachLevel {
  if (API_KINDS.has(kind)) return BROWSER_PERMISSIONS.has(value) ? 4 : 1;
  return coversAllSites(value) ? 3 : 2;
}

/** One permission in plain words, without the "Can ask for" prefix. */
export function permissionLabel(kind: PermissionKind, value: string): string {
  if (API_KINDS.has(kind)) return PERMISSION_LABELS[value] ?? value;
  if (kind === 'content_scripts') {
    return coversAllSites(value)
      ? 'Run scripts on every site you visit'
      : `Run scripts on ${value}`;
  }
  return coversAllSites(value)
    ? 'Read and change every site you visit'
    : `Read and change ${value}`;
}

export interface Grant {
  /** Plain words, e.g. "Store its own data" or "Can ask for: Read your clipboard". */
  label: string;
  /** The raw manifest key, e.g. `permissions: storage`. */
  raw: string;
  /** Reaches all sites or the browser, so it's shown in amber. Never true for optional ones. */
  high: boolean;
}

const OPTIONAL_KINDS = new Set<PermissionKind>([
  'optional_permissions',
  'optional_host_permissions',
]);

/** Every permission, widest first, then the optional ones the extension can ask for. */
export function grants(manifest: Manifest): Grant[] {
  const all = readPermissions(manifest);
  const required: (Grant & { level: ReachLevel })[] = [];
  const optional: Grant[] = [];
  const kinds: PermissionKind[] = [
    'host_permissions',
    'content_scripts',
    'permissions',
    'optional_host_permissions',
    'optional_permissions',
  ];
  for (const kind of kinds) {
    for (const value of all[kind]) {
      const raw = `${kind}: ${value}`;
      if (OPTIONAL_KINDS.has(kind)) {
        optional.push({ label: `Can ask for: ${permissionLabel(kind, value)}`, raw, high: false });
      } else {
        const level = grantLevel(kind, value);
        required.push({
          label: permissionLabel(kind, value),
          raw,
          high: level >= HIGH_REACH,
          level,
        });
      }
    }
  }
  const sorted = required
    .toSorted((a, b) => b.level - a.level)
    .map(({ label, raw, high }) => ({ label, raw, high }));
  return [...sorted, ...optional];
}

export interface TrailChange {
  text: string;
  /** Adds access, so it's shown in amber. */
  adds: boolean;
}

/** How many added permissions the trail names before "and N more". */
const MAX_NAMED_CHANGES = 3;

function named(values: string[]): string {
  if (values.length <= MAX_NAMED_CHANGES) return values.join(', ');
  return `${values.slice(0, MAX_NAMED_CHANGES).join(', ')} and ${values.length - MAX_NAMED_CHANGES} more`;
}

/**
 * A release's permission change for the review trail: "Listed" for the first,
 * then "No permission changes", "Added access to all sites", "Added: tabs,
 * cookies" or "Removed: …". Optional additions are named "optional tabs".
 */
export function trailChange(previous: Manifest | undefined, next: Manifest): TrailChange {
  if (previous === undefined) return { text: 'Listed', adds: false };
  const diff = diffRelease(previous, next);
  let allSites = false;
  const added: string[] = [];
  const removed: string[] = [];
  for (const change of diff.permissions) {
    const optional = OPTIONAL_KINDS.has(change.kind);
    for (const value of change.added) {
      if (!API_KINDS.has(change.kind) && !optional && coversAllSites(value)) allSites = true;
      else added.push(optional ? `optional ${value}` : value);
    }
    removed.push(...change.removed);
  }
  if (allSites && added.length === 0) return { text: 'Added access to all sites', adds: true };
  if (allSites || added.length > 0) {
    return { text: `Added: ${named(allSites ? ['all sites', ...added] : added)}`, adds: true };
  }
  if (removed.length > 0) return { text: `Removed: ${named(removed)}`, adds: false };
  return { text: 'No permission changes', adds: false };
}
