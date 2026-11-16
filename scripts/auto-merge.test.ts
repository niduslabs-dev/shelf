import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { liveProblems, parseVerdict } from './auto-merge.ts';
import type { Verdict } from './pr-check.ts';

const SHA = 'a'.repeat(40);
const PATH = `extensions/${'b'.repeat(32)}/release.json`;
const verdict: Verdict = { pr: 7, headSha: SHA, eligible: true, reasons: [] };

describe('parseVerdict', () => {
  it('reads a well-formed verdict', () => {
    assert.deepEqual(parseVerdict(JSON.stringify(verdict)), verdict);
    const byHand = { pr: 7, headSha: SHA, eligible: false, reasons: ['a new listing'] };
    assert.deepEqual(parseVerdict(JSON.stringify(byHand)), byHand);
  });

  it('refuses anything loose or extra', () => {
    const cases: [unknown, RegExp][] = [
      [[], /not an object/],
      [{ ...verdict, merge: true }, /has keys/],
      [{ ...verdict, pr: '7' }, /pr is not/],
      [{ ...verdict, pr: 0 }, /pr is not/],
      [{ ...verdict, pr: 1.5 }, /pr is not/],
      [{ ...verdict, headSha: 'main' }, /headSha/],
      [{ ...verdict, headSha: SHA.toUpperCase() }, /headSha/],
      [{ ...verdict, eligible: 'true' }, /eligible is not/],
      [{ ...verdict, reasons: [1] }, /reasons/],
      [{ ...verdict, reasons: ['x'] }, /disagrees/],
      [{ ...verdict, eligible: false }, /disagrees/],
    ];
    for (const [value, pattern] of cases) {
      assert.match(JSON.stringify(parseVerdict(JSON.stringify(value))), pattern);
    }
    assert.match(JSON.stringify(parseVerdict('{')), /not JSON/);
  });
});

describe('liveProblems', () => {
  const pull = {
    number: 7,
    state: 'open',
    merged: false,
    changed_files: 1,
    base: { ref: 'main' },
    head: { sha: SHA },
  };
  const files = [{ filename: PATH, status: 'modified' }];

  it('passes the PR that was checked', () => {
    assert.deepEqual(liveProblems(verdict, pull, files), []);
  });

  it('refuses a PR that moved on', () => {
    const cases: [unknown, unknown, RegExp][] = [
      [{ ...pull, number: 8 }, files, /another PR/],
      [{ ...pull, state: 'closed' }, files, /no longer open/],
      [{ ...pull, merged: true }, files, /no longer open/],
      [{ ...pull, base: { ref: 'old' } }, files, /no longer targets main/],
      [{ ...pull, head: { sha: 'c'.repeat(40) } }, files, /new commits/],
      [{ ...pull, changed_files: 2 }, files, /more than one file/],
      [pull, [...files, { filename: 'README.md', status: 'modified' }], /only one release/],
      [pull, [{ filename: 'scripts/x.ts', status: 'modified' }], /only one release/],
      [pull, [{ filename: PATH, status: 'added' }], /only one release/],
      [pull, [], /only one release/],
      [pull, { filename: PATH }, /only one release/],
      [undefined, files, /another PR/],
    ];
    for (const [livePull, liveFiles, pattern] of cases) {
      assert.match(liveProblems(verdict, livePull, liveFiles).join('; '), pattern);
    }
  });
});
