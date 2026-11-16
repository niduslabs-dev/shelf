/** Where the registry lives. These URLs are baked into installed extensions, so they never change. */

/** The registry's origin. Every listed extension's `update_url` is fixed to it forever. */
export const REGISTRY_ORIGIN = 'https://shelf.niduslabs.dev';
/** The registry's GitHub repo, which stores approved `.crx` files on its Releases. */
export const REGISTRY_REPO = 'niduslabs-dev/shelf';

export function updateUrlFor(id: string): string {
  return `${REGISTRY_ORIGIN}/updates/${id}.xml`;
}

/** The registry's stored copy of an approved release: Release `<id>-<version>`, asset `<id>.crx`. */
export function approvedCrxUrl(id: string, version: string): string {
  return `https://github.com/${REGISTRY_REPO}/releases/download/${id}-${version}/${id}.crx`;
}
