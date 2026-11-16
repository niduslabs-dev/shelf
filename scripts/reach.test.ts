import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coversAllSites, grants, permissionLabel, reachLevel, trailChange } from './reach.ts';

describe('reachLevel', () => {
  it('is "Own data" with no site access and no browser permissions', () => {
    assert.equal(reachLevel({}), 1);
    assert.equal(reachLevel({ permissions: ['storage', 'alarms', 'contextMenus'] }), 1);
  });

  it('is "Some sites" for named hosts or content-script matches', () => {
    assert.equal(reachLevel({ host_permissions: ['https://example.com/*'] }), 2);
    assert.equal(
      reachLevel({ content_scripts: [{ matches: ['https://*.example.com/*'], js: ['a.js'] }] }),
      2,
    );
  });

  it('is "All sites" for any pattern covering every site', () => {
    for (const pattern of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', 'ws://*/path']) {
      assert.equal(reachLevel({ host_permissions: [pattern] }), 3, pattern);
    }
    assert.equal(reachLevel({ content_scripts: [{ matches: ['<all_urls>'] }] }), 3);
  });

  it('is "Your browser" for any browser permission, whatever the sites', () => {
    for (const name of [
      'tabs',
      'history',
      'cookies',
      'webRequest',
      'declarativeNetRequestFeedback',
    ]) {
      assert.equal(reachLevel({ permissions: [name] }), 4, name);
    }
    assert.equal(reachLevel({ permissions: ['tabs'], host_permissions: ['<all_urls>'] }), 4);
  });

  it('ignores optional permissions', () => {
    assert.equal(
      reachLevel({ optional_permissions: ['tabs'], optional_host_permissions: ['<all_urls>'] }),
      1,
    );
  });
});

describe('coversAllSites', () => {
  it('only matches a wildcard host', () => {
    assert.equal(coversAllSites('https://*.example.com/*'), false);
    assert.equal(coversAllSites('https://example.com/*'), false);
    assert.equal(coversAllSites('file:///*'), false);
    assert.equal(coversAllSites('*://*/*'), true);
  });
});

describe('permission labels', () => {
  it('uses plain words for common permissions and the raw name otherwise', () => {
    assert.equal(permissionLabel('permissions', 'storage'), 'Store its own data');
    assert.equal(permissionLabel('permissions', 'tabs'), 'See your tabs and their addresses');
    assert.equal(permissionLabel('permissions', 'someNewApi'), 'someNewApi');
    assert.equal(
      permissionLabel('host_permissions', '<all_urls>'),
      'Read and change every site you visit',
    );
    assert.equal(
      permissionLabel('host_permissions', 'https://example.com/*'),
      'Read and change https://example.com/*',
    );
    assert.equal(
      permissionLabel('content_scripts', 'https://example.com/*'),
      'Run scripts on https://example.com/*',
    );
  });

  it('never uses em dashes', () => {
    for (const name of ['storage', 'tabs', 'history', 'webRequest', 'activeTab', 'scripting']) {
      assert.doesNotMatch(permissionLabel('permissions', name), /—/);
    }
  });

  it('lists the widest grants first, then what it can ask for', () => {
    assert.deepEqual(
      grants({
        permissions: ['storage', 'tabs'],
        host_permissions: ['https://example.com/*', '<all_urls>'],
        optional_permissions: ['clipboardRead'],
      }),
      [
        { label: 'See your tabs and their addresses', raw: 'permissions: tabs', high: true },
        {
          label: 'Read and change every site you visit',
          raw: 'host_permissions: <all_urls>',
          high: true,
        },
        {
          label: 'Read and change https://example.com/*',
          raw: 'host_permissions: https://example.com/*',
          high: false,
        },
        { label: 'Store its own data', raw: 'permissions: storage', high: false },
        {
          label: 'Can ask for: Read your clipboard',
          raw: 'optional_permissions: clipboardRead',
          high: false,
        },
      ],
    );
  });
});

describe('trailChange', () => {
  const base = { permissions: ['storage'] };

  it('says "Listed" for the first release', () => {
    assert.deepEqual(trailChange(undefined, base), { text: 'Listed', adds: false });
  });

  it('says when nothing changed', () => {
    assert.deepEqual(trailChange(base, { ...base, description: 'new' }), {
      text: 'No permission changes',
      adds: false,
    });
  });

  it('names added access to all sites', () => {
    assert.deepEqual(trailChange(base, { ...base, host_permissions: ['<all_urls>'] }), {
      text: 'Added access to all sites',
      adds: true,
    });
  });

  it('names added permissions, and all sites among them', () => {
    assert.deepEqual(trailChange(base, { permissions: ['storage', 'tabs', 'cookies'] }), {
      text: 'Added: cookies, tabs',
      adds: true,
    });
    assert.deepEqual(
      trailChange(base, { permissions: ['storage', 'tabs'], host_permissions: ['*://*/*'] }),
      { text: 'Added: all sites, tabs', adds: true },
    );
    assert.deepEqual(trailChange(base, { permissions: ['storage', 'a', 'b', 'c', 'd', 'e'] }), {
      text: 'Added: a, b, c and 2 more',
      adds: true,
    });
  });

  it('marks optional additions and plain removals', () => {
    assert.deepEqual(trailChange(base, { ...base, optional_permissions: ['tabs'] }), {
      text: 'Added: optional tabs',
      adds: true,
    });
    assert.deepEqual(trailChange({ permissions: ['storage', 'tabs'] }, base), {
      text: 'Removed: tabs',
      adds: false,
    });
  });
});
