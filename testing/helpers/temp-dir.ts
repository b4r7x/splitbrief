import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SPLITBRIEF_IDENTITY } from '../../src/core/identity.js';

/** Every directory these helpers created in this test file. The setup file removes them after the file ends. */
export const createdTempDirs = new Set<string>();

/**
 * Every folder that may hold a sandbox root: each directory these helpers created, and each
 * project a cleanup found inside one, by each path form a test can pass. A sandbox env keeps its
 * temp directory outside the project, under a name hashed from the root path, so the setup file
 * removes those after the file ends (`state-home.ts`).
 */
export const sandboxProjectDirs = new Set<string>();

function recordSandboxProject(dir: string): void {
  sandboxProjectDirs.add(dir);
  sandboxProjectDirs.add(realpathSync(dir));
  sandboxProjectDirs.add(normalizeMacTmpPath(dir) ?? dir);
}

/**
 * Records every folder in `dir`, `dir` included, that holds a `.splitbrief` folder. A project can
 * sit at any depth: a staged-copy workspace under `.splitbrief/sessions`, a worktree under the state
 * home, a project subfolder. A test that moves or replaces a project on purpose calls it first.
 * The walk follows no link: a sandbox home links into the state folders of this machine.
 */
export function recordSandboxProjects(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === SPLITBRIEF_IDENTITY.stateDir) recordSandboxProject(dir);
    recordSandboxProjects(join(dir, entry.name));
  }
}

// A cleanup also gets a path that is gone, a file or a link, which `rmSync` takes as it is.
function isDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

export function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  createdTempDirs.add(dir);
  recordSandboxProject(dir);
  return dir;
}

/** Normalize macOS's /private aliases when comparing temporary paths. */
export function normalizeMacTmpPath(path: string | null): string | null {
  return path?.replace(/^\/private(\/(?:tmp|var)\/)/, '$1') ?? null;
}

export function cleanupTempDir(dir: string): void {
  if (isDirectory(dir)) recordSandboxProjects(dir);
  // maxRetries re-walks the tree when a straggler process (e.g. a fixture's fake command still
  // draining stdin) recreates an entry mid-delete and rmdir reports ENOTEMPTY.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  createdTempDirs.add(dir);
  recordSandboxProject(dir);
  try {
    return await fn(dir);
  } finally {
    if (isDirectory(dir)) recordSandboxProjects(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
