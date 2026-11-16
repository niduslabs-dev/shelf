# Shelf: agent guide

> Part of the Nidus Labs workspace (`~/Work/personal/niduslabs`). Start with the workspace guide `../AGENTS.md` and `../STATUS.md`; this file covers this repo only. The design and what's decided are in `../plans/shelf.md`.

A public registry of Chromium extensions for Helium and ungoogled-chromium users, at `shelf.niduslabs.dev` (GitHub Pages). Authors sign their own `.crx` files; the registry verifies them in CI, stores approved files on this repo's GitHub Releases and serves each extension's `updates.xml`. No servers.

## Layout

```
scripts/
  crx3.ts            CRX3 verification (signatures, ID from the developer key), following Chromium's crx_verifier.cc
  protobuf.ts        the minimal protobuf reader crx3.ts needs
  crx3.test.ts       tests against Helium-packed files, Chromium's own test files and crafted ones
  testing/           test-only helpers (a CRX3 writer for broken files)
  fixtures/          .crx files: helium-* packed by Helium 0.21.1.1, chromium-* from Chromium's components/test/data/crx_file
.github/workflows/   ci.yml (typecheck, lint, format, test)
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
- **`update_url` is permanent.** Every listed extension has `https://shelf.niduslabs.dev/updates/<id>.xml` baked in. Never move or drop that path.
- **Fixture keys stay out of git.** The `.pem` files that made `helium-*` fixtures live in the workspace's `.claude/research/` folders.
- **CI runs on GitHub's free runners** (public repo). Don't set `LINUX_RUNNER` to Blacksmith here; that would spend the shared Blacksmith minutes for nothing.
