/**
 * What an extension can reach, read from its manifest, and how a release
 * changes it (spec check 5). The report goes in a PR comment for the reviewer.
 */
import { isRecord } from './manifest.ts';
import type { Manifest } from './manifest.ts';

/** The manifest fields that grant access, plus content-script matches. */
export const PERMISSION_KINDS = [
  'permissions',
  'host_permissions',
  'optional_permissions',
  'optional_host_permissions',
  'content_scripts',
] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export type Permissions = Record<PermissionKind, string[]>;

/** Top-level keys the permission diff already covers, or that change every release. */
const KEYS_NOT_IN_OTHER_CHANGES = new Set<string>([...PERMISSION_KINDS, 'version']);

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].toSorted();
}

export function readPermissions(manifest: Manifest): Permissions {
  const scripts: unknown[] = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts
    : [];
  const scriptMatches = scripts.flatMap((script) =>
    isRecord(script) ? strings(script.matches) : [],
  );
  return {
    permissions: sortedUnique(strings(manifest.permissions)),
    host_permissions: sortedUnique(strings(manifest.host_permissions)),
    optional_permissions: sortedUnique(strings(manifest.optional_permissions)),
    optional_host_permissions: sortedUnique(strings(manifest.optional_host_permissions)),
    content_scripts: sortedUnique(scriptMatches),
  };
}

export interface PermissionChange {
  kind: PermissionKind;
  added: string[];
  removed: string[];
}

export interface ReleaseDiff {
  /** One entry per kind that changed. */
  permissions: PermissionChange[];
  /** True when anything was added to any kind. */
  addsPermissions: boolean;
  /** Other top-level manifest keys that were added, removed or changed. */
  otherChangedKeys: string[];
}

/** Compares a release with the approved one. With no approved one (a new listing), everything counts as added. */
export function diffRelease(previous: Manifest | undefined, next: Manifest): ReleaseDiff {
  const before = previous ? readPermissions(previous) : undefined;
  const after = readPermissions(next);
  const permissions: PermissionChange[] = [];
  for (const kind of PERMISSION_KINDS) {
    const old = new Set(before?.[kind] ?? []);
    const now = new Set(after[kind]);
    const added = after[kind].filter((value) => !old.has(value));
    const removed = [...old].filter((value) => !now.has(value));
    if (added.length > 0 || removed.length > 0) permissions.push({ kind, added, removed });
  }

  const otherChangedKeys = previous
    ? sortedUnique([...Object.keys(previous), ...Object.keys(next)]).filter(
        (key) =>
          !KEYS_NOT_IN_OTHER_CHANGES.has(key) &&
          JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
      )
    : [];

  return {
    permissions,
    addsPermissions: permissions.some((change) => change.added.length > 0),
    otherChangedKeys,
  };
}

const KIND_LABELS: Record<PermissionKind, string> = {
  permissions: 'API permissions',
  host_permissions: 'Site access',
  optional_permissions: 'Optional API permissions',
  optional_host_permissions: 'Optional site access',
  content_scripts: 'Content scripts run on',
};

function code(values: string[]): string {
  return values.map((value) => `\`${value.replaceAll('`', '')}\``).join(', ');
}

/** The permission part of the PR comment, in Markdown. */
export function permissionReport(previous: Manifest | undefined, next: Manifest): string {
  const lines: string[] = [];
  if (previous === undefined) {
    lines.push('**New listing.** Everything this extension can reach:', '');
    const all = readPermissions(next);
    for (const kind of PERMISSION_KINDS) {
      lines.push(`- ${KIND_LABELS[kind]}: ${all[kind].length > 0 ? code(all[kind]) : 'none'}`);
    }
    return lines.join('\n');
  }

  const diff = diffRelease(previous, next);
  lines.push(diff.addsPermissions ? '**Adds permissions.**' : '**No new permissions.**', '');
  if (diff.permissions.length === 0) lines.push('- Permissions unchanged.');
  for (const change of diff.permissions) {
    if (change.added.length > 0)
      lines.push(`- ${KIND_LABELS[change.kind]}, added: ${code(change.added)}`);
    if (change.removed.length > 0) {
      lines.push(`- ${KIND_LABELS[change.kind]}, removed: ${code(change.removed)}`);
    }
  }
  if (diff.otherChangedKeys.length > 0) {
    lines.push('', `Other manifest changes: ${code(diff.otherChangedKeys)}.`);
  }
  return lines.join('\n');
}
