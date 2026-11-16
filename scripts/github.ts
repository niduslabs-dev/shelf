/**
 * The few GitHub REST calls the checks need, over `fetch`, plus a capped
 * download for `.crx` files. No SDK, so nothing outside `node:` runs in CI.
 */
import { isRecord } from './manifest.ts';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
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
  /** Every Release tag in the repo, drafts included. */
  async releaseTags(repo: string): Promise<string[]> {
    const tags: string[] = [];
    for (let page = 1; ; page++) {
      // oxlint-disable-next-line no-await-in-loop
      const batch = await this.#json(`/repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Unexpected releases response');
      for (const item of batch as unknown[]) {
        if (typeof item === 'object' && item !== null && 'tag_name' in item)
          tags.push(String(item.tag_name));
      }
      if (batch.length < PAGE_SIZE) return tags;
    }
  }

  /** When each published Release was published, by tag (drafts are left out). */
  async releaseDates(repo: string): Promise<Map<string, string>> {
    const dates = new Map<string, string>();
    for (let page = 1; ; page++) {
      // oxlint-disable-next-line no-await-in-loop
      const batch = await this.#json(`/repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Unexpected releases response');
      for (const item of batch as unknown[]) {
        if (!isRecord(item) || item.draft === true) continue;
        if (typeof item.tag_name === 'string' && typeof item.published_at === 'string')
          dates.set(item.tag_name, item.published_at);
      }
      if (batch.length < PAGE_SIZE) return dates;
    }
  }

  /** The SHAs of the default branch's commits that touched `path`, newest first. */
  async commitsFor(repo: string, path: string): Promise<string[]> {
    const shas: string[] = [];
    for (let page = 1; ; page++) {
      // oxlint-disable-next-line no-await-in-loop
      const batch = await this.#json(
        `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error('Unexpected commits response');
      for (const item of batch as unknown[]) {
        if (isRecord(item) && typeof item.sha === 'string') shas.push(item.sha);
      }
      if (batch.length < PAGE_SIZE) return shas;
    }
  }

  /** The pull request a commit on the default branch came from, preferring a merged one. */
  async pullForCommit(repo: string, sha: string): Promise<number | undefined> {
    const pulls = await this.#json(`/repos/${repo}/commits/${encodeURIComponent(sha)}/pulls`);
    if (!Array.isArray(pulls)) throw new Error('Unexpected commit pulls response');
    const found = (pulls as unknown[]).filter(isRecord);
    const pull = found.find((item) => typeof item.merged_at === 'string') ?? found[0];
    return typeof pull?.number === 'number' ? pull.number : undefined;
  }

  /** True when the repo has a published Release with this tag (drafts don't count). */
  async hasRelease(repo: string, tag: string): Promise<boolean> {
    const response = await this.#request(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (response.status === HTTP_NOT_FOUND) return false;
    if (!response.ok) throw new Error(`GitHub release ${tag}: ${response.status}`);
    return true;
  }

  /**
   * Creates a Release with one asset: as a draft first, so a failed upload
   * never leaves a published Release without its file, then published.
   */
  async createRelease(
    repo: string,
    release: { tag: string; target: string; name: string; body: string },
    asset: { name: string; contentType: string; bytes: Uint8Array },
  ): Promise<void> {
    const created = await this.#request(`/repos/${repo}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: release.tag,
        target_commitish: release.target,
        name: release.name,
        body: release.body,
        draft: true,
        make_latest: 'false',
      }),
    });
    if (!created.ok) throw new Error(`Creating release ${release.tag} failed: ${created.status}`);
    const draft: unknown = await created.json();
    const id =
      typeof draft === 'object' && draft !== null && 'id' in draft ? Number(draft.id) : NaN;
    if (!Number.isInteger(id)) throw new Error('Unexpected create release response');

    const upload = await fetch(
      `${UPLOADS}/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': asset.contentType,
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': API_VERSION,
        },
        body: asset.bytes,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      },
    );
    if (!upload.ok) throw new Error(`Uploading ${asset.name} failed: ${upload.status}`);

    const published = await this.#request(`/repos/${repo}/releases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ draft: false, make_latest: 'false' }),
    });
    if (!published.ok)
      throw new Error(`Publishing release ${release.tag} failed: ${published.status}`);
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
