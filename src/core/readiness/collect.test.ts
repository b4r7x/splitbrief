import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, detachHead, startConflictingMerge } from '#testing/helpers/git.js';
import { LOCKFILE, sessionDir, STATE_FILE } from '../paths.js';
import { createInitialState } from '../state/machine.js';
import { writeActive } from '../sessions/lifecycle.js';
import { currentProcessStartTimeMs } from '../../lib/process/start-time.js';
import { HEARTBEAT_STALENESS_MS } from '../sessions/lockfile-status.js';
import { collectReadiness } from './collect.js';
import { flattenReadinessChecks } from './status.js';

function writeSessionState(projectDir: string, sessionId: string, phase: string): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  const state = { ...createInitialState('feature'), phase };
  writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
}

function writeSessionLockfile(
  projectDir: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(
    join(sDir, LOCKFILE),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      startTimeMs: currentProcessStartTimeMs(),
      lastAliveMs: Date.now(),
      sessionId,
      mode: 'standard',
      feature: 'feature',
      ...overrides,
    }),
  );
}

describe('collectReadiness validation probe wiring', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-probe');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function redAtStartConfig() {
    return makeConfig({
      validation: {
        typecheck: true,
        lint: false,
        test: false,
        typecheckCommand: 'node -e "process.exit(1)"',
      },
    });
  }

  it('surfaces an already-failing check when probeValidation is enabled', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: redAtStartConfig(),
      probeValidation: true,
    });

    const checks = flattenReadinessChecks(report.sections);
    const failing = checks.find((check) => check.id === 'validation.already-failing');
    expect(failing).toBeDefined();
    expect(failing?.severity).toBe('warning');
    expect(failing?.summary).toContain('typecheck');
  });

  it('does not run the probe when probeValidation is omitted', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: redAtStartConfig(),
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(checks.find((check) => check.id === 'validation.already-failing')).toBeUndefined();
  });
});

describe('collectReadiness git posture', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-git-posture');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('warns when the repository is on a detached HEAD', async () => {
    createTestGitRepo(tempDir);
    detachHead(tempDir);

    const { report } = await collectReadiness({ projectDir: tempDir });

    const detached = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'repo.detached-head',
    );
    expect(detached?.severity).toBe('warning');
  });

  it('does not warn about a detached HEAD when on a branch', async () => {
    createTestGitRepo(tempDir);

    const { report } = await collectReadiness({ projectDir: tempDir });

    expect(
      flattenReadinessChecks(report.sections).find((check) => check.id === 'repo.detached-head'),
    ).toBeUndefined();
  });

  it('blocks when a merge is in progress', async () => {
    startConflictingMerge(tempDir);

    const { report } = await collectReadiness({ projectDir: tempDir });

    const inProgress = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'repo.in-progress-git-op',
    );
    expect(inProgress?.severity).toBe('blocker');
    expect(report.status).toBe('blocked');
  });

  it('does not warn about git identity when it is configured and commits are enabled', async () => {
    createTestGitRepo(tempDir);

    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig({ workflow: { git: { commitStrategy: 'per-task' } } }),
    });

    expect(
      flattenReadinessChecks(report.sections).find(
        (check) => check.id === 'repo.git-identity-missing',
      ),
    ).toBeUndefined();
  });

  it('reports an active session with a stale heartbeat as stale', async () => {
    createTestGitRepo(tempDir);
    const sessionId = '2026-04-18-stale-heartbeat';
    writeSessionState(tempDir, sessionId, 'implementing');
    writeSessionLockfile(tempDir, sessionId, {
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });
    writeActive({ projectDir: tempDir, sessionId });

    const { report } = await collectReadiness({ projectDir: tempDir });

    const activeSession = flattenReadinessChecks(report.sections).find((check) =>
      check.id.startsWith('repo.active-session-'),
    );
    expect(activeSession?.id).toBe('repo.active-session-stale');
    expect(activeSession?.metadata).toMatchObject({ sessionId, live: false });
  });
});
