# Shelf: agent guide

> Part of the Nidus Labs workspace (`~/Work/personal/niduslabs`). Start with the workspace guide `../AGENTS.md` and `../STATUS.md`; this file covers this repo only. The design and what's decided are in `../plans/shelf.md`.

A public registry of Chromium extensions for Helium and ungoogled-chromium users, at `shelf.niduslabs.dev` (a static-assets Worker on Cloudflare). Authors sign their own `.crx` files; the registry verifies them in CI, stores approved files on this repo's GitHub Releases and serves each extension's `updates.xml`. No servers.

## Layout

```
scripts/
  crx3.ts            CRX3 verification (signatures, ID from the developer key), following Chromium's crx_verifier.cc
  protobuf.ts        the minimal protobuf reader crx3.ts needs
  zip.ts             strict zip reader: refuses names that would collide on disk (case, Unicode form), Zip64, encryption
  manifest.ts        reads manifest.json (strict JSON) and checks a release: MV3, version, higher than current, update_url
  permissions.ts     what a manifest can reach, the diff between releases, and the PR comment's Markdown
  schema.ts          listing.json, release.json, blocklist.json, delisted.json and authors' shelf.json claim files
  standing.ts        an ID's state: listed, blocked, removed or left
  registry.ts        the registry's fixed URLs (update_url, stored .crx assets)
  github.ts          the GitHub REST calls and the capped .crx download, over fetch
  zip-write.ts       deterministic zip writer (sorted entries, fixed timestamps, deflate)
  crx3-write.ts      CRX3 writer: one RSA proof, signed_header_data holding the crx_id
  pack.ts            packs an author's folder into a signed .crx: skips dotfiles, refuses .pem/.key files, checks MV3 and update_url, then runs verifyRelease on the result
  release-action.ts  the publish Action's steps: `pack` and `summary` (release.json, draft listing.json, links that open the Shelf PR)
  verify-release.ts  the checks a downloaded .crx must pass against release.json (hash, signature, ID, manifest), shared by PR check and publish
  pr-check.ts        runs every PR check and renders the comment; pr-check.yml runs it
  publish.ts         stores approved .crx files on Releases `<id>-<version>` and builds the site into _site/; publish.yml runs it, then deploys
  site.ts            the site's files: updates/<id>.xml, index.json, blocked.json, _headers, a placeholder index.html
  *.test.ts          tests: Helium-packed files, Chromium's own test files, crafted broken files and archives
  testing/           test-only writers (CRX3 and zip) for broken files
  fixtures/          .crx files: helium-* packed by Helium 0.21.1.1, chromium-* from Chromium's components/test/data/crx_file
actions/publish/     the authors' publish Action (composite): pack and sign, GitHub Release `v<version>`, job summary with the PR links
wrangler.jsonc       Worker `shelf`: serves _site/ at shelf.niduslabs.dev (custom domain; Wrangler made the DNS record)
.github/workflows/   ci.yml (typecheck, lint, format, test), pr-check.yml (listing and release PRs), publish.yml (on main: store releases, build, deploy with Wrangler)
blocklist.json       blocked extension IDs (update file answers "no update")
delisted.json        IDs no longer listed: `removed` ("no update") or `left` (its final release stays served)
extensions/<id>/     listing.json and release.json per extension (none yet)
```

## Commands

```bash
pnpm test           # node --test, running the TypeScript directly (Node strips types)
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint --type-aware
pnpm format         # oxfmt (format:check in CI)
```

## Rules

- **CI never runs code from a pull request.** The PR workflows use `pull_request_target`, so they only download and parse files (`.crx`, JSON). Never `pnpm install`, build or execute anything from the PR's checkout.
- **No runtime dependencies in the verification path.** `scripts/` uses `node:` modules only, so a compromised package can't approve a release. Dev tools are pinned exactly.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): Node runs the files directly, so no enums, namespaces or parameter properties.
- **Security code changes need a test that fails without them.** When changing `crx3.ts`, compare with Chromium's `components/crx_file/crx_verifier.cc` and add a case.
- **`update_url` is permanent, so an update file never disappears.** Every ID that was ever listed answers forever: listed (latest), blocked or `removed` ("no update"), or `left` (its final release). To unlist, add a `removed` entry to delisted.json; never just delete `extensions/<id>/`. Publish stops if an ID with stored releases has none of these.
- **Leaving:** a maintainer adds a `left` entry first; then the author's final release PR may move `update_url` to their own https URL, once. Keep `extensions/<id>/` with that final release.
- **Stored releases are never replaced.** Publish only creates Release `<id>-<version>` or compares it with release.json's SHA-256. A mismatch stops the deploy; a maintainer investigates by hand.
- **The index page is a placeholder.** Its design goes on a canvas first (ask Jatin which), never straight into code.
- **The publish Action never holds a Shelf token.** It runs in authors' repos, creates their Release with their `GITHUB_TOKEN`, and ends with a job summary whose links open the Shelf PR in the browser. Authors pin it to a full commit SHA (`niduslabs-dev/shelf/actions/publish@<sha>`), so a change only reaches them when they bump it; the template repo `niduslabs-dev/shelf-extension-template` pins the current one. Third-party actions inside it are pinned by SHA too, since its steps see the author's signing key.
- **The signing key never touches disk.** `pack.ts` reads it from `SHELF_SIGNING_KEY` into memory, and its errors never quote it.
- **Fixture keys stay out of git.** The `.pem` files that made `helium-*` fixtures live in the workspace's `.claude/research/` folders.
- **The Cloudflare token lives only in the `production` environment,** which only `main` can deploy to. Never make it a repo secret or pass it to a job that a pull request can trigger.
- **No challenges on this hostname.** Update checkers can't solve Cloudflare challenges, so Bot Fight Mode is off for the zone and a Configuration Rule turns Browser Integrity Check off here (see the workspace guide). publish.yml's live check prints Cloudflare's headers if a challenge (`cf-mitigated`) ever comes back.
- **Worker logs stay off** (`observability` in wrangler.jsonc): Shelf keeps no record of who checks for updates.
- **CI runs on GitHub's free runners** (public repo). Don't set `LINUX_RUNNER` to Blacksmith here; that would spend the shared Blacksmith minutes for nothing.
