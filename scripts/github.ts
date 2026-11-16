/**
 * The few GitHub REST calls the checks need, over `fetch`, plus a capped
 * download for `.crx` files. No SDK, so nothing outside `node:` runs in CI.
 */
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'shelf-registry-ci';
const API_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
/** Comfortably above any real extension; GitHub release assets can be far larger. */
export const MAX_CRX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const HTTP_NOT_FOUND = 404;

export interface PrFile {
  path: string;
  /** added, modified, removed, renamed, copied, changed or unchanged. */
  status: string;
}

export class GitHub {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async #request(
    path: string,
    init: RequestInit = {},
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.#token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return response;
  }

  async #json(path: string): Promise<unknown> {
    const response = await this.#request(path);
    if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
    return response.json();
  }

  /** Every file a pull request changes, with its status. */
  async pullRequestFiles(repo: string, number: number): Promise<PrFile[]> {
    const files: PrFile[] = [];
    for (let page = 1; ; page++) {
      // Pages are fetched in turn: a short page is how we know it's the last one.
      // oxlint-disable-next-line no-await-in-loop
      const batch = await this.#json(
        `/repos/${repo}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error('Unexpected pull request files response');
      for (const item of batch as unknown[]) {
        if (typeof item === 'object' && item !== null && 'filename' in item && 'status' in item) {
          files.push({ path: String(item.filename), status: String(item.status) });
        }
      }
      if (batch.length < PAGE_SIZE) return files;
    }
  }

  /** A file's text at a ref (the default branch when `ref` is omitted), or `undefined` when it doesn't exist. */
  async fileText(repo: string, path: string, ref?: string): Promise<string | undefined> {
    const query = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await this.#request(
      `/repos/${repo}/contents/${encodedPath}${query}`,
      {},
      'application/vnd.github.raw+json',
    );
    if (response.status === HTTP_NOT_FOUND) return undefined;
    if (!response.ok) throw new Error(`GitHub contents ${repo}/${path}: ${response.status}`);
    return response.text();
  }

  /** Creates the PR comment holding `marker`, or edits the existing one. */
  async upsertComment(repo: string, number: number, marker: string, body: string): Promise<void> {
    let existing: number | undefined;
    for (let page = 1; existing === undefined; page++) {
      // oxlint-disable-next-line no-await-in-loop
      const batch = await this.#json(
        `/repos/${repo}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error('Unexpected comments response');
      for (const item of batch as unknown[]) {
        if (typeof item !== 'object' || item === null || !('body' in item) || !('id' in item))
          continue;
        const login =
          'user' in item &&
          typeof item.user === 'object' &&
          item.user !== null &&
          'login' in item.user
            ? item.user.login
            : '';
        if (login === 'github-actions[bot]' && String(item.body).includes(marker))
          existing = Number(item.id);
      }
      if (batch.length < PAGE_SIZE) break;
    }
    const path =
      existing === undefined
        ? `/repos/${repo}/issues/${number}/comments`
        : `/repos/${repo}/issues/comments/${existing}`;
    const response = await this.#request(path, {
      method: existing === undefined ? 'POST' : 'PATCH',
      body: JSON.stringify({ body }),
    });
    if (!response.ok) throw new Error(`Posting the comment failed: ${response.status}`);
  }
}

/** Downloads a file, following redirects, refusing anything over `MAX_CRX_BYTES` or slower than the timeout. */
export async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null)
    throw new Error(`Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_CRX_BYTES)
    throw new Error(`The file is over ${MAX_CRX_BYTES / 1024 / 1024} MB`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    // Sequential by nature: each read waits for the next chunk of the stream.
    // oxlint-disable-next-line no-await-in-loop
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) throw new Error('Unexpected download chunk');
    total += value.length;
    if (total > MAX_CRX_BYTES) {
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw new Error(`The file is over ${MAX_CRX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
