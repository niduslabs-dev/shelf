/**
 * Where an extension stands in the registry. Once an ID has been listed, its
 * update file must answer forever (installed copies have the URL baked in),
 * so every ID is in exactly one of these states, and none of them is a 404.
 */
import type { BlockedExtension, DelistedExtension } from './schema.ts';

export type Standing = 'listed' | 'blocked' | 'removed' | 'left';

/** blocklist.json and delisted.json, as `main` has them. Only a maintainer edits either. */
export interface RegistryLists {
  blocklist: BlockedExtension[];
  delisted: DelistedExtension[];
}

/** Blocking wins over everything: a blocked extension never gets another version. */
export function standingOf(id: string, lists: RegistryLists): Standing {
  if (lists.blocklist.some((entry) => entry.id === id)) return 'blocked';
  return lists.delisted.find((entry) => entry.id === id)?.kind ?? 'listed';
}
