# Shelf: agent guide

> Part of the Nidus Labs workspace (`~/Work/personal/niduslabs`). Start with the workspace guide `../AGENTS.md` and `../STATUS.md`; this file covers this repo only. Why it works this way, and what was tested in Helium: `docs/design.md`.

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
  pr-check.ts        runs every PR check, decides auto-merge eligibility and renders the comment; pr-check.yml runs it
  auto-merge.ts      auto-merge.yml's checks: the verdict artifact's shape, then the live PR against it
  publish.ts         stores approved .crx files on Releases `<id>-<version>`, gathers the store pages' data (size, icon, review trail) and builds the site into _site/; publish.yml runs it, then deploys
  trail-cache.ts     the review trail's cache in .cache/trail/ (publish.yml keeps it with actions/cache): one entry per immutable Release tag, so older .crx files and PR lookups aren't repeated; a "no PR found" answer is retried after 24 hours
  site.ts            the site's files: updates/<id>.xml, index.json, blocked.json, _headers, the store pages, icons and site/'s static files
  pages.ts           the store's HTML: the home page shell (data as JSON) and the server-rendered extension pages; the one HTML-escape helper
  reach.ts           reach level (own data, some sites, all sites, your browser), permissions in plain words, and the trail's permission-change wording
  icon.ts            the largest PNG icon from a verified archive (512 KB cap, PNG signature)
  *.test.ts          tests: Helium-packed files, Chromium's own test files, crafted broken files and archives
  testing/           test-only writers (CRX3 and zip) for broken files
  fixtures/          .crx files: helium-* packed by Helium 0.21.1.1, chromium-* from Chromium's components/test/data/crx_file
site/                the store's browser files, copied as they are: shelf.css (tokens and every style) and shelf.js (home list, search, setup dialog, install status)
actions/publish/     the authors' publish Action (composite): pack and sign, GitHub Release `v<version>`, job summary with the PR links
wrangler.jsonc       Worker `shelf`: serves _site/ at shelf.niduslabs.dev (custom domain; Wrangler made the DNS record)
.github/workflows/   ci.yml (typecheck, lint, format, test), pr-check.yml (listing and release PRs), auto-merge.yml (merges eligible releases; off by default), publish.yml (on main: store releases, build, deploy with Wrangler)
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

## The store site

`buildSite` writes everything into `_site/`; the Worker serves it with `drop-trailing-slash`, so `e/<id>/index.html` is `/e/<id>`.

- **Home `/`:** listed extensions (not blocked, removed or left), newest review first, as JSON in `<script type="application/json" id="data">`. shelf.js draws the rows, live search (`?q=`), the empty search, the empty registry and the setup dialog (`?setup` opens it).
- **Extension page `/e/<id>`:** rendered here: icon (or a letter tile), author and source links, Install, version and size, summary, the manifest description (left out when missing or a `__MSG_` placeholder), "What it can reach", the review trail, the details and "Report a problem".
- **Install** is a real link to the stored `.crx`. The first click opens the setup dialog instead (remembered in `localStorage`); after that the link goes ahead, Helium prompts, and the status line says so.
- **Reach:** 4 for any browser permission (tabs, history, cookies, webRequest and the rest in reach.ts), 3 for a host or content-script match covering every site, 2 for any other, 1 otherwise. Optional permissions don't raise it; they're listed as "Can ask for: …".
- **Review trail:** every stored Release `<id>-<version>`, newest first, dated by its `published_at`. The first says "Listed"; the rest diff each manifest with the one before (older `.crx` files are downloaded once, then read from the trail cache). The review link is the PR behind the commit that first set that version in release.json (`/commits?path=`, then `/commits/{sha}/pulls`). Anything publish can't gather becomes a warning in the log, never a stopped deploy.
- **Fonts:** Manrope from Google Fonts, as in the prototype.
- **Check it locally:** `node .claude/checks/build-local-site.ts [empty]` builds `_site/` from crafted entries (one long name, one hostile name), then `pnpm exec wrangler dev --port <free port> --compatibility-date <one the local workerd supports>` serves it with the real `_headers`.

## Auto-merge (off by default)

Auto-merge is **on** (`SHELF_AUTO_MERGE=true` since 2026-11-16). Every PR it doesn't cover is reviewed by hand; with the variable unset, all of them are. Turn it on with `gh variable set SHELF_AUTO_MERGE --body true -R niduslabs-dev/shelf`; delete the variable (`gh variable delete SHELF_AUTO_MERGE -R niduslabs-dev/shelf`) to turn it off.

- **What it merges** (`autoMergeVerdict` in pr-check.ts): a release, not a new listing, of a listed extension (not blocked, removed or left, so never a final release), into `main`, by a publisher in its `shelf.json`, changing only `extensions/<id>/release.json`, with every check passed, no added permissions, host permissions, optional permissions or content-script matches, and no other manifest key changed. The PR comment says "Eligible for auto-merge" or "Reviewed by hand: <reasons>", and links REVIEW.md.
- **How:** pr-check.yml uploads `verdict.json` (`{ pr, headSha, eligible, reasons }`, kept one day). auto-merge.yml runs on `workflow_run` after a successful PR check that was a `pull_request_target` run of pr-check.yml, reads the verdict with auto-merge.ts, re-reads the live PR (open, into `main`, same head commit, still one release.json), squash-merges with `--match-head-commit`, then dispatches Publish, since merges made with `GITHUB_TOKEN` start no push workflows.
- **Why two workflows:** the token that can write to `main` never runs next to anything a PR can influence. pr-check.yml handles PR data with a read-only token; auto-merge.yml holds the write token but checks out only `main`, installs nothing and treats the artifact as data. Keep it that way: never add a PR checkout, an install or `${{ }}` inside `run` to auto-merge.yml.

## Rules

- **CI never runs code from a pull request.** The PR workflows use `pull_request_target`, so they only download and parse files (`.crx`, JSON). Never `pnpm install`, build or execute anything from the PR's checkout.
- **No runtime dependencies in the verification path.** `scripts/` uses `node:` modules only, so a compromised package can't approve a release. Dev tools are pinned exactly.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): Node runs the files directly, so no enums, namespaces or parameter properties.
- **Security code changes need a test that fails without them.** When changing `crx3.ts`, compare with Chromium's `components/crx_file/crx_verifier.cc` and add a case.
- **`update_url` is permanent, so an update file never disappears.** Every ID that was ever listed answers forever: listed (latest), blocked or `removed` ("no update"), or `left` (its final release). To unlist, add a `removed` entry to delisted.json; never just delete `extensions/<id>/`. Publish stops if an ID with stored releases has none of these.
- **Leaving:** a maintainer adds a `left` entry first; then the author's final release PR may move `update_url` to their own https URL, once. Keep `extensions/<id>/` with that final release.
- **Stored releases are never replaced.** Publish only creates Release `<id>-<version>` or compares it with release.json's SHA-256. A mismatch stops the deploy; a maintainer investigates by hand.
- **Store page changes start from the design.** The approved prototype is in the workspace's `.claude/prototypes/shelf-store/` (screenshots in `shots/`, `r4-*` the approved round, `site-*` the built site); the canvas is in the workspace guide. Change the design first, never straight in code.
- **Listing and manifest text is untrusted on the pages too.** Server side it only goes through `escapeHtml` in pages.ts; in the browser only through `textContent` (a test fails if shelf.js uses `innerHTML` or the like). The home page's JSON escapes `<`, `>` and `&`. The CSP in `_headers` allows only the site's own script and styles plus Google Fonts, so no inline scripts, styles or event handlers.
- **The publish Action never holds a Shelf token.** It runs in authors' repos, creates their Release with their `GITHUB_TOKEN`, and ends with a job summary whose links open the Shelf PR in the browser. Authors pin it to a full commit SHA (`niduslabs-dev/shelf/actions/publish@<sha>`), so a change only reaches them when they bump it; the template repo `niduslabs-dev/shelf-extension-template` pins the current one. Third-party actions inside it are pinned by SHA too, since its steps see the author's signing key.
- **The signing key never touches disk.** `pack.ts` reads it from `SHELF_SIGNING_KEY` into memory, and its errors never quote it.
- **Fixture keys stay out of git.** The `.pem` files that made `helium-*` fixtures live in the workspace's `.claude/research/` folders.
- **The Cloudflare token lives only in the `production` environment,** which only `main` can deploy to. Never make it a repo secret or pass it to a job that a pull request can trigger.
- **No challenges on this hostname.** Update checkers can't solve Cloudflare challenges, so Bot Fight Mode is off for the zone and a Configuration Rule turns Browser Integrity Check off here (see the workspace guide). publish.yml's live check prints Cloudflare's headers if a challenge (`cf-mitigated`) ever comes back.
- **Pages make no third-party requests.** Manrope is self-hosted in `site/fonts/` (SIL OFL, licence alongside) and the CSP allows only `'self'`. Never add a CDN, analytics or remote font; it would break "Shelf keeps no record". After a deploy, Cloudflare's edge may serve the old HTML for up to 5 minutes.
- **Worker logs stay off** (`observability` in wrangler.jsonc): Shelf keeps no record of who checks for updates.
- **CI runs on GitHub's free runners** (public repo). Don't set `LINUX_RUNNER` to Blacksmith here; that would spend the shared Blacksmith minutes for nothing.
