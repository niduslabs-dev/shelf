# Security

## Report a malicious extension or a leaked key

Report privately, not in a public issue:

- **GitHub:** [open a private security advisory](https://github.com/niduslabs-dev/shelf/security/advisories/new) on this repo.
- **Email:** support@niduslabs.dev, with "Shelf security" in the subject.

Include the extension's ID or Shelf page, what you saw, and how to reproduce it if you can. If you're an author whose signing key may have leaked, say so in the first line.

## What happens next

1. Shelf confirms it got your report.
2. If the report is credible, the extension is **blocked first and investigated after**. Blocking stops every further update the same day: its update file answers "no update" and it leaves the index.
3. Shelf works with the author where it can, and publishes the reason on the [blocked list](https://shelf.niduslabs.dev/blocked.json).

## What blocking can and can't do

- **It can** stop any further version from reaching anyone, which is what matters most when a key leaks.
- **It can't** remove or disable copies people already installed. Shelf has no way to reach into a browser. If an installed version is harmful, Shelf says so on the blocked list so people can remove it themselves.

## Problems in Shelf itself

Bugs in Shelf's checks, publishing or site (for example, a way to get an unreviewed `.crx` stored, or to bypass the signature check) go through the same private advisory. Please don't test against other authors' listings.
