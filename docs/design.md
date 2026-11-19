# Shelf: design and decisions

What Shelf is, why it works this way, and what was tested in Helium before it was built. Moved here from the workspace plan (`studio/shelf/plan.md`, deleted 2026-11-19 once Shelf went live; git keeps it). `AGENTS.md` is the map of the code, the store site and the rules.

## Goal

A small public registry where anyone can list their own Chromium extension, for **Helium and ungoogled-chromium** users. Users install with one click and get automatic updates. Stock Chrome, Brave and Edge are out of scope.

## Decisions

- **Updates go through the registry.** Every listed extension's `update_url` points at the registry. Users only receive versions the registry approved. A release is a PR to the registry, so nothing has to be detected or polled. (This replaced the earlier "authors host their own updates" decision on 2026-11-12.)
- **The registry stores the approved `.crx` files itself.** Reason: Helium ignores the `hash_sha256` pin in the update file (tested, see below). Pointing at an author-hosted file would let the author swap it after approval.
- **Authors keep their own signing keys.** The registry never signs anything. An extension's ID comes from its key, so the ID proves who signed a release.
- **A person reviews new listings and any release that adds permissions.** Releases that add nothing go through auto-merge (`AGENTS.md`, "Auto-merge").
- **No servers.** One GitHub repo, GitHub Actions and static hosting.
- **The site is a static-assets Worker at `shelf.niduslabs.dev`** (switched from GitHub Pages on 2026-11-16, before anything was listed). Wrangler's `custom_domain` creates the DNS record and certificate with the shared token, which can't edit DNS directly; no other account can claim the name (a Pages domain can be taken over if Pages is ever switched off); same pattern as the other Nidus Labs sites. The Cloudflare token is a secret of the `production` environment, which only `main` can deploy to. Worker logs are off. The `.crx` files stay on GitHub Releases.
- **Domain `shelf.niduslabs.dev` from day one** (agreed 2026-11-16), since `update_url` is permanent.
- **Authors need a public source repo** (agreed 2026-11-16). It also anchors the ownership check. It doesn't prove the `.crx` was built from it; the site must not claim that.
- **Auto-merge is narrow** (agreed 2026-11-16, turned on the same day). "No new permissions" doesn't stop a malicious update that uses permissions it already has, so auto-merge covers only a listed extension's release by a listed publisher that changes nothing else in the manifest.

## Prior art

- **NeverDecaf/chromium-web-store:** a client that checks for updates. We recommend users install it.
- **imputnet/omaha:** the Helium team's early Rust update-server crates. Watch it, but it's too new to depend on.
- **Signing tools:** npm `crx3` (one maintainer) and `go-crx3`. The old npm `crx` is dead.
- Nothing existing covers a multi-author registry where authors keep their own keys.

## What we tested in Helium 157

Throwaway profile, localhost update server, extension packed with `Helium --pack-extension --pack-extension-key`. Update checks were triggered through `chrome.developerPrivate.autoUpdate()` over CDP on chrome://extensions.

| Behaviour | Result |
|---|---|
| Install a `.crx` from a link with `#extension-mime-request-handling` set to "Always prompt for install" | Works (one click on the prompt) |
| Auto-update from a third-party `update_url` | Works, fetched directly, not through Helium's own servers |
| Update signed with a different key | Refused |
| `hash_sha256` in `updates.xml` doesn't match the file | **Ignored. Helium installed it anyway** (tested twice) |

Also seen: Helium reports `os=win` to the update server, even on a Mac.

**Install from a GitHub Release asset, tested on this Mac 2026-11-16 (Helium 0.21.1.1)** (evidence in `.claude/research/shelf-install-test/`): GitHub answers with a 302 to a signed `release-assets.githubusercontent.com` URL (not ending in `.crx`), served as `application/octet-stream` with `attachment`. On localhost copies of that, with the flag on, Helium showed the "Add extension" prompt in every case (correct MIME, GitHub's headers, the redirect, no `Content-Disposition`). With the flag at Default every case is refused (`CRX_REQUIRED_PROOF_MISSING`), so the flag is required whatever the host. So GitHub Releases work for storing `.crx` files, and the MIME type doesn't matter. Not confirmed here: pressing "Add extension" (the dialog isn't in the accessibility tree), and real GitHub URLs over HTTPS in the browser.

**Update through GitHub's redirect, tested on this Mac 2026-11-16 (Helium 0.21.1.1)** (evidence in `.claude/research/shelf-update-redirect-test/`): with `codebase` pointing at a GitHub-style `/releases/download/...` path that 302s to an asset URL not ending in `.crx` (`application/octet-stream`, `attachment`), Helium followed the redirect and updated v1 to v2, with or without `hash_sha256`. So `updates.xml` can point straight at GitHub Release asset URLs. The update request is a GET with `os=win&arch=x64&prod=chromecrx&acceptformat=crx3,puff` and the ID and version, and no other identifier. v1 was installed as an external extension (an `External Extensions/<id>.json` inside the throwaway `--user-data-dir`, which Chromium reads on macOS), since the install prompt can't be clicked by automation; that trick is also how CI or local tests can install without a prompt. Not verified: the update of an extension added through the prompt (same Chromium update code), and real HTTPS to GitHub's asset host.

Not tested: Helium's real timed update check (about 5 hours in Chromium). Checks were triggered by hand.

## Files

`listing.json` (written once, by the author's first PR):

```json
{ "name": "Example", "summary": "One line, under 100 characters.", "author": "github-login", "repo": "https://github.com/github-login/example" }
```

`shelf.json` (in the author's source repo, at the root of the default branch; the claim file for check 2):

```json
{ "extensions": { "<id>": { "publishers": ["github-login", "some-bot[bot]"] } } }
```

`release.json` (one PR per release; the author's publish Action writes it and links to the PR):

```json
{ "version": "2.0", "crx": "https://github.com/github-login/example/releases/download/v2.0/example.crx", "sha256": "<64 lowercase hex>" }
```

`sha256` (added 2026-11-16) records the exact bytes under review, in git. The PR check refuses a download that doesn't match it, and publish checks it again before storing, so "the same bytes CI verified" needs no hand-off between workflows.

The registry serves one update file per extension, at `https://<registry host>/updates/<id>.xml`. That exact URL must be the extension's `update_url`.

## Checks on every PR

1. **Schema and scope:** fields present, the folder name is a valid ID, and the `crx` URL is a release asset of the listing's own repo (`https://github.com/<owner>/<repo>/releases/download/...`, decided 2026-11-16). The PR touches one extension folder and only `listing.json` and `release.json`; anything else needs a maintainer. A blocked ID fails.
2. **Ownership:** the source repo's default branch has a `shelf.json` claim file listing this extension ID and the GitHub logins allowed to publish it, and the PR author is one of them. (Decided 2026-11-16. GitHub only shows a repo's collaborator permissions to people with push access, tested: 403, so the spec's original "admin or maintain access" check can't work. Only someone with push access can write the claim file, it covers organisation repos and several maintainers, and an author's publish bot can be listed.)
3. **Signature:** download the `.crx`. Verify the CRX3 signature, and check that the ID derived from the signing key equals the folder ID.
4. **Manifest:** inside the `.crx`, `manifest_version` is 3, `version` equals `release.json`, the version is higher than the current one, and `update_url` equals the registry's URL for this ID.
5. **Permissions:** compare `permissions`, `host_permissions`, `optional_permissions` and content-script matches with the current approved version. Post the result as a PR comment.
6. **Merge rule:** auto-merge is **on** (`SHELF_AUTO_MERGE=true`, turned on by Jatin 2026-11-16); everything it doesn't cover is reviewed and merged by hand. The comment flags new listings and added permissions for a closer look, and says whether a PR is eligible for auto-merge. With the repo variable `SHELF_AUTO_MERGE` set to `true`, auto-merge.yml merges a release of a listed extension by a publisher that changes only its release.json, passes every check, adds no permissions or content-script matches and changes no other manifest key, then dispatches Publish. It runs as a separate `workflow_run` workflow so the merge token never runs next to anything a PR influences (details in `shelf/AGENTS.md`).

The workflow only downloads and parses files. It checks out `main`, never the PR, reads the PR's JSON through the API at the PR's commit, and installs nothing (the checks have no runtime dependencies and Node runs the TypeScript directly). The token can read the repo and comment on PRs, with no secrets. That keeps `pull_request_target` safe. One comment per PR, updated on each push, holds the results, the `.crx`'s SHA-256 and the permission report. Everything auto-merge doesn't cover is merged by hand.

## On merge (publish.yml)

1. For every listed extension whose Release `<id>-<version>` doesn't exist yet: download the `.crx` again and re-run the checks, including the SHA-256 from release.json. Releases already stored are compared with that SHA-256, never replaced. Any problem stops the run before the deploy. (Built 2026-11-16; it reconciles every listing on each run, so a re-run is always safe.)
2. Upload it as an asset on the registry's Release `<id>-<version>`.
3. Rewrite `updates/<id>.xml` to point at that stored asset.
4. Rebuild and deploy the site.

## Blocking

```json
[{ "id": "...", "reason": "Shipped a credential stealer in 2.3.0", "date": "2026-11-12" }]
```

Blocking stops serving updates (its update file answers `status='noupdate'`, not yet tried in Helium), removes the extension from the index, and adds it to a public "blocked" list (`blocked.json`).

Every ID that was ever listed keeps an update file (built 2026-11-16): `delisted.json` records `removed` IDs, which answer "no update" like blocked ones, and `left` IDs, whose final release stays served. Publish refuses to deploy if an ID with stored releases has no listing, blocklist entry or `removed` entry, so a path can't start returning 404.

**Limit, stated plainly:** people who already installed it keep their current version. The registry can't uninstall or disable it. Blocking does stop any further version reaching them, which matters most when an author's key leaks.

## Leaving the registry

An author can't change `update_url` without shipping a new version, and the only update channel is the registry. So the registry promises to accept one final release whose `update_url` points somewhere else.
- **Built 2026-11-16:** a maintainer adds `{ "id", "kind": "left", "reason", "date" }` to `delisted.json`. The author's next release PR may then move `update_url` to their own https URL, once; it's still signed by their key and passes every other check. The PR comment marks it as a final release.
- After that, the extension leaves the index, but its update file keeps serving that final release forever, so copies still on older versions can follow it out.

## Tooling choices

- **CRX3 verification: our own, built 2026-11-16** (`shelf/scripts/crx3.ts`, `node:crypto` only). It follows Chromium's `crx_verifier.cc`: every signature must be valid, one must come from the key behind the declared ID, and headers containing zip end-of-directory markers are refused. Tested against Helium-packed files (Helium's reported ID), Chromium's own test files and crafted broken ones.
  - Considered: npm `crx3` (one maintainer, built mainly for creating .crx files), `go-crx3` (adds Go to CI), and imputnet/omaha's `crx3` crate (Rust, 1.0 since 2026-11-08, by the Helium team; it would add a Rust build to CI). Worth a cross-check later: run omaha's `omaha-publish verify` against our fixtures.

## Out of scope for version 1

- Stock Chrome, Brave and Edge (they need policy files or Load unpacked).
- Accounts, ratings and comments.
- Automatic malware scanning beyond the permission report.
