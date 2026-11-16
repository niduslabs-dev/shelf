import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { draftListing, jsonFile, releaseAssetUrl, renderSummary } from './release-action.ts';
import { parseListing, parseRelease } from './schema.ts';

const ID = 'momhecocnmkhlmlfajehcajpfkbcldic';
const REPO = 'someone/example';
const release = {
  version: '1.2',
  crx: releaseAssetUrl(REPO, 'v1.2', `${ID}-1.2.crx`),
  sha256: 'a'.repeat(64),
};
const draft = draftListing({ name: 'Example', description: 'Does a thing.' }, REPO, 'someone');

describe('release.json and listing.json from the Action', () => {
  it('pass the registry schema', () => {
    assert.ok(parseRelease(jsonFile(release), { owner: 'someone', name: 'example' }).ok);
    assert.ok(parseListing(jsonFile(draft)).ok);
  });

  it('uses placeholders for localized names', () => {
    const listing = draftListing({ name: '__MSG_name__' }, REPO, 'someone');
    assert.notEqual(listing.name, '__MSG_name__');
    assert.ok(parseListing(jsonFile(listing)).ok);
  });
});

describe('renderSummary', () => {
  it('links a prefilled new file for a new listing', () => {
    const markdown = renderSummary({
      id: ID,
      release,
      repo: REPO,
      existingListing: undefined,
      draft,
    });
    const url = `https://github.com/niduslabs-dev/shelf/new/main?filename=${encodeURIComponent(`extensions/${ID}/release.json`)}&value=${encodeURIComponent(jsonFile(release))}`;
    assert.ok(markdown.includes(url));
    assert.ok(markdown.includes('"author": "someone"'));
    assert.ok(markdown.includes('#extension-mime-request-handling'));
    assert.ok(!markdown.includes('—'));
  });

  it('links the edit page for a release', () => {
    const existing = jsonFile({ ...draft, repo: 'https://github.com/someone/example' });
    const markdown = renderSummary({
      id: ID,
      release,
      repo: REPO,
      existingListing: existing,
      draft,
    });
    assert.ok(
      markdown.includes(
        `https://github.com/niduslabs-dev/shelf/edit/main/extensions/${ID}/release.json`,
      ),
    );
    assert.ok(markdown.includes(release.sha256));
    assert.ok(!markdown.includes('[!WARNING]'));
  });

  it('warns when the listing names another repo', () => {
    const existing = jsonFile({ ...draft, repo: 'https://github.com/other/repo' });
    const markdown = renderSummary({
      id: ID,
      release,
      repo: REPO,
      existingListing: existing,
      draft,
    });
    assert.ok(markdown.includes('[!WARNING]'));
  });
});
