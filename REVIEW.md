# How Shelf reviews extensions

Every new listing, and every release that a person reviews, is checked against this page. The automatic checks (signature, ID, manifest, permissions) run first. This page covers what a person looks at.

A reviewer can ask questions on the pull request. Answer there; a release can be updated by pushing to the same branch.

## What every listing needs

- **A public source repo** with the code the `.crx` is built from, and a `shelf.json` naming who may publish.
- **Readable code.** Shelf has to be able to read what it approves.
- **An honest listing.** The name and summary say what the extension does, without claiming to be something else.
- **A reason for each permission.** If it isn't obvious from the code, say why in the pull request.

## What gets a listing or release refused

- **Code a reviewer can't read:** obfuscated or packed code with no readable source in the repo. Ordinary minification of a bundle is fine when the repo builds it.
- **Code that isn't in the package:** loading or running scripts from the network, or `eval` on fetched data. Extensions must ship all of their code in the `.crx`.
- **More access than the job needs:** for example, every site when it only works on one, or reading history for a feature that doesn't need it.
- **Tracking or data collection the user didn't ask for:** analytics, fingerprinting or sending browsing data anywhere, unless that is the extension's stated purpose and the user turns it on.
- **Ads and injected content** in pages the extension didn't create.
- **Pretending to be someone else:** names, icons or listings that copy another extension or company.
- **Anything illegal or harmful:** malware, credential theft, cryptocurrency mining.

## How reviews work

- **New listings** are always reviewed by a person.
- **Releases** are reviewed by a person too. Shelf may later merge releases automatically when they add no permissions and change nothing else in the manifest; the pull request comment says when that applies.
- **New permissions** get a closer look. Say in the pull request why the release needs them.
- **Decisions** are explained on the pull request. If a listing is refused, the comment says why and what would change the answer.

## After a listing

- **Updates** reach users only after they pass review, through Shelf's update file. Shelf never changes an author's code.
- **Blocking:** an extension that turns out to break these rules, or whose author's key may have leaked, is blocked. Blocking stops every further update. It can't remove copies people already installed, so Shelf says so on the blocked list.
- **Leaving:** an author can move their extension to another update server. Open an issue, and Shelf accepts one final release that points elsewhere.

Problems with a listed extension: [report it](https://github.com/niduslabs-dev/shelf/issues/new?template=report-a-problem.yml). Security problems: see [SECURITY.md](SECURITY.md).
