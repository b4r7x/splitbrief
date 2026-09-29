import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../paths-io.js';
import { sessionDir } from '../paths.js';
import { taskId } from '../schemas/task.js';
import type { ReviewChange } from '../schemas/review-changes.js';
import { sha256Hex } from '../../utils/sha256.js';
import { appendReviewChanges, readReviewChanges, REVIEW_CHANGES_FILE } from './review-changes.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

const projects: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const project of projects.splice(0)) cleanupTempDir(project);
});

function fixture() {
  const projectDir = createTempDir('review-changes');
  projects.push(projectDir);
  const ref = { projectDir, sessionId: 'review-test' };
  ensureSessionDir(projectDir, ref.sessionId);
  const path = join(sessionDir(projectDir, ref.sessionId), REVIEW_CHANGES_FILE);
  const bytes = Buffer.from('run output\n');
  const change: ReviewChange = {
    kind: 'captured',
    taskId: taskId('T001'),
    briefHash: 'brief',
    path: 'src/code.ts',
    before: null,
    after: { base64: bytes.toString('base64'), sha256: sha256Hex(bytes), mode: 0o644 },
  };
  return { ref, path, change };
}

describe('review changes confinement', () => {
  it('round-trips ordinary records through a private artifact', () => {
    const { ref, path, change } = fixture();
    expect(readReviewChanges(ref)).toBeNull();
    appendReviewChanges(ref, [change]);
    appendReviewChanges(ref, [change]);
    expect(readReviewChanges(ref)?.changes).toEqual([change, change]);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects hardlinked records before reading or appending', () => {
    const { ref, path, change } = fixture();
    appendReviewChanges(ref, [change]);
    const outside = join(ref.projectDir, 'outside.json');
    const original = readFileSync(path, 'utf8');
    writeFileSync(outside, original);
    rmSync(path);
    linkSync(outside, path);
    expect(() => readReviewChanges(ref)).toThrow();
    expect(() => appendReviewChanges(ref, [change])).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe(original);
  });

  it('rejects a session-directory alias before creating a lock or artifact', () => {
    const { ref, path, change } = fixture();
    appendReviewChanges(ref, [change]);
    const outside = join(ref.projectDir, 'outside-session');
    mkdirSync(outside);
    const aliasRef = { ...ref, sessionId: 'alias' };
    const aliasedFile = join(outside, REVIEW_CHANGES_FILE);
    const original = JSON.stringify({ ...readReviewChanges(ref), sessionId: aliasRef.sessionId });
    writeFileSync(aliasedFile, original);
    symlinkSync(outside, sessionDir(ref.projectDir, aliasRef.sessionId));
    expect(() => readReviewChanges(aliasRef)).toThrow();
    expect(() => appendReviewChanges(aliasRef, [change])).toThrow();
    expect(readFileSync(aliasedFile, 'utf8')).toBe(original);
    expect(existsSync(`${aliasedFile}.lock`)).toBe(false);
    expect(readFileSync(path, 'utf8')).toContain('review-test');
  });

  it('refuses a final symlink substituted immediately before opening', () => {
    const { ref, path, change } = fixture();
    appendReviewChanges(ref, [change]);
    const outside = join(ref.projectDir, 'outside.json');
    writeFileSync(outside, readFileSync(path));
    let swapped = false;
    const swapTarget = () => {
      if (swapped) return;
      rmSync(path);
      symlinkSync(outside, path);
      swapped = true;
    };
    const originalOpen = fs.openSync;
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (args[0] === path) swapTarget();
      return originalOpen(...args);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === path) swapTarget();
      return originalRead(...args);
    });
    let readError: unknown;
    try {
      readReviewChanges(ref);
    } catch (err) {
      readError = err;
    }
    expect(swapped).toBe(true);
    expect(readError).toBeDefined();
  });
});
