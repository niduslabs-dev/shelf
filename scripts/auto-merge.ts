/**
 * The checks `auto-merge.yml` runs before it merges a release PR without a
 * person. It is off unless the repo variable `SHELF_AUTO_MERGE` is `true`.
 *
 * The verdict comes from pr-check.ts on `main`, but it reaches this job as an
 * artifact, so it is parsed as data and its shape checked strictly. The PR is
 * then read again through the API (by the workflow, with `gh api`) and must
 * still be the one that was checked: open, into `main`, at the same commit,
 * changing only one extension's release.json.
 *
 * Usage:
 *   node scripts/auto-merge.ts verdict <verdict.json>
 *     prints `eligible=`, `pr=` and `sha=` lines for $GITHUB_OUTPUT; exits
 *     non-zero only when the verdict is malformed
 *   node scripts/auto-merge.ts live <verdict.json> <pull.json> <files.json>
 *     exits non-zero when the live PR is not the one that was checked
 */
import { readFileSync } from 'node:fs';

import { isRecord } from './manifest.ts';
import type { Verdict } from './pr-check.ts';
import { MAIN_BRANCH } from './pr-check.ts';

const VERDICT_KEYS = ['eligible', 'headSha', 'pr', 'reasons'];
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_FILE = /^extensions\/[a-p]{32}\/release\.json$/;

/** The verdict, or why it can't be used. Unknown keys or loose types are refused. */
export function parseVerdict(text: string): Verdict | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'verdict.json is not JSON';
  }
  if (!isRecord(value)) return 'verdict.json is not an object';
  const keys = Object.keys(value).toSorted();
  if (keys.join() !== VERDICT_KEYS.join()) return `verdict.json has keys ${keys.join(', ')}`;
  const { pr, headSha, eligible, reasons } = value;
  if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1) return 'pr is not a PR number';
  if (typeof headSha !== 'string' || !SHA.test(headSha)) return 'headSha is not a commit SHA';
  if (typeof eligible !== 'boolean') return 'eligible is not a boolean';
  if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === 'string')) {
    return 'reasons is not a list of strings';
  }
  if (eligible !== (reasons.length === 0)) return 'eligible disagrees with reasons';
  return { pr, headSha, eligible, reasons };
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Compares the live PR (`GET /pulls/{n}`) and its files (`GET /pulls/{n}/files`,
 * first page) with the verdict. Returns the reasons not to merge; empty means go.
 */
export function liveProblems(verdict: Verdict, pull: unknown, files: unknown): string[] {
  const problems: string[] = [];
  if (field(pull, 'number') !== verdict.pr) problems.push('the API returned another PR');
  if (field(pull, 'state') !== 'open' || field(pull, 'merged') === true) {
    problems.push('the PR is no longer open');
  }
  if (field(pull, 'base', 'ref') !== MAIN_BRANCH)
    problems.push(`the PR no longer targets ${MAIN_BRANCH}`);
  if (field(pull, 'head', 'sha') !== verdict.headSha)
    problems.push('the PR has new commits since the check');
  if (field(pull, 'changed_files') !== 1) problems.push('the PR changes more than one file');
  const [only] = Array.isArray(files) ? (files as unknown[]) : [];
  const filename = field(only, 'filename');
  if (
    !Array.isArray(files) ||
    files.length !== 1 ||
    typeof filename !== 'string' ||
    !RELEASE_FILE.test(filename) ||
    field(only, 'status') !== 'modified'
  ) {
    problems.push('the PR no longer changes only one release.json');
  }
  return problems;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function verdictFrom(path: string): Verdict {
  const verdict = parseVerdict(readFileSync(path, 'utf8'));
  if (typeof verdict === 'string') throw new Error(verdict);
  return verdict;
}

function main(args: string[]): void {
  const [mode, verdictPath, pullPath, filesPath] = args;
  if (verdictPath === undefined)
    throw new Error('Usage: auto-merge.ts verdict|live <verdict.json> …');
  const verdict = verdictFrom(verdictPath);
  if (mode === 'verdict') {
    if (!verdict.eligible) {
      process.stderr.write(
        // JSON keeps author-chosen manifest keys from starting a line of their own.
        `PR #${verdict.pr} is reviewed by hand: ${JSON.stringify(verdict.reasons)}\n`,
      );
    }
    // Only validated fields reach $GITHUB_OUTPUT; the reasons stay on stderr.
    process.stdout.write(
      `eligible=${verdict.eligible}\npr=${verdict.pr}\nsha=${verdict.headSha}\n`,
    );
    return;
  }
  if (mode === 'live' && pullPath !== undefined && filesPath !== undefined) {
    const problems = liveProblems(verdict, readJson(pullPath), readJson(filesPath));
    if (problems.length > 0) {
      process.stderr.write(`Not merging PR #${verdict.pr}: ${problems.join('; ')}\n`);
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('Usage: auto-merge.ts verdict|live <verdict.json> …');
}

if (import.meta.main) main(process.argv.slice(2));
