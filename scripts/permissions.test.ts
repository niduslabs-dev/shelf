import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffRelease, permissionReport, readPermissions } from './permissions.ts';

const v1 = {
  version: '1.0',
  name: 'Example',
  permissions: ['storage', 'tabs', 'storage'],
  host_permissions: ['https://example.com/*'],
  content_scripts: [
    { matches: ['https://example.com/*'], js: ['a.js'] },
    { matches: ['https://example.org/*', 42], js: ['b.js'] },
  ],
};

describe('readPermissions', () => {
  it('collects, dedupes and sorts every kind, ignoring non-strings', () => {
    assert.deepEqual(readPermissions(v1), {
      permissions: ['storage', 'tabs'],
      host_permissions: ['https://example.com/*'],
      optional_permissions: [],
      optional_host_permissions: [],
      content_scripts: ['https://example.com/*', 'https://example.org/*'],
    });
  });

  it('survives malformed fields', () => {
    const permissions = readPermissions({
      permissions: 'tabs',
      content_scripts: [null, 'x', { matches: 'y' }],
    });
    assert.deepEqual(permissions.permissions, []);
    assert.deepEqual(permissions.content_scripts, []);
  });
});

describe('diffRelease', () => {
  it('sees no new permissions when only the version and code change', () => {
    const diff = diffRelease(v1, { ...v1, version: '1.1' });
    assert.equal(diff.addsPermissions, false);
    assert.deepEqual(diff.permissions, []);
    assert.deepEqual(diff.otherChangedKeys, []);
  });

  it('sees fewer permissions as no new permissions', () => {
    const diff = diffRelease(v1, { ...v1, permissions: ['storage'] });
    assert.equal(diff.addsPermissions, false);
    assert.deepEqual(diff.permissions, [{ kind: 'permissions', added: [], removed: ['tabs'] }]);
  });

  it('sees an added host, optional permission or content-script match', () => {
    assert.equal(
      diffRelease(v1, { ...v1, host_permissions: ['<all_urls>'] }).addsPermissions,
      true,
    );
    assert.equal(
      diffRelease(v1, { ...v1, optional_permissions: ['downloads'] }).addsPermissions,
      true,
    );
    assert.equal(
      diffRelease(v1, { ...v1, content_scripts: [{ matches: ['https://bank.example/*'] }] })
        .addsPermissions,
      true,
    );
  });

  it('lists other manifest keys that changed', () => {
    const diff = diffRelease(v1, {
      ...v1,
      name: 'Renamed',
      externally_connectable: { matches: ['*://*/*'] },
    });
    assert.deepEqual(diff.otherChangedKeys, ['externally_connectable', 'name']);
  });

  it('treats everything as added for a new listing', () => {
    assert.equal(diffRelease(undefined, v1).addsPermissions, true);
  });
});

describe('permissionReport', () => {
  it('lists everything for a new listing', () => {
    const report = permissionReport(undefined, v1);
    assert.match(report, /New listing/);
    assert.match(report, /API permissions: `storage`, `tabs`/);
    assert.match(report, /Optional site access: none/);
  });

  it('shows additions and removals for a release', () => {
    const report = permissionReport(v1, { ...v1, permissions: ['storage', 'cookies'] });
    assert.match(report, /Adds permissions/);
    assert.match(report, /API permissions, added: `cookies`/);
    assert.match(report, /API permissions, removed: `tabs`/);
  });

  it('says so when nothing changed', () => {
    assert.match(
      permissionReport(v1, { ...v1, version: '1.1' }),
      /No new permissions[\s\S]*unchanged/,
    );
  });

  it('strips backticks so a permission string cannot break out of the Markdown', () => {
    assert.doesNotMatch(permissionReport(undefined, { permissions: ['a`b'] }), /a`b/);
  });
});
