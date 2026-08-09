import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, detachHead, startConflictingMerge } from '#testing/helpers/git.js';
import {
  LOCKFILE,
  sessionDir,
  STATE_FILE,
  SPLITBRIEF_DIR,
  CONFIG_FILE,
  TREES_DIR,
} from '../paths.js';
import { createInitialState } from '../state/machine.js';
import { writeActive } from '../sessions/lifecycle.js';
import { HEARTBEAT_STALENESS_MS } from '../sessions/lockfile-status.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { applyRunnerPreparationChecks, collectReadiness } from './collect.js';
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
  overrides: Parameters<typeof makeSessionLockfile>[1] = {},
): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(join(sDir, LOCKFILE), JSON.stringify(makeSessionLockfile(sessionId, overrides)));
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

describe('collectReadiness runner availability wiring', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-availability');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('turns an unreachable default implementer into a blocker', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      probeRunnerAvailability: async () => [
        {
          slot: { role: 'implementer', profile: 'default' },
          provider: 'ollama',
          endpoint: 'http://localhost:11434/v1',
          verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
        },
      ],
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(
      checks.find((check) => check.id === 'runners.availability.implementer.default'),
    ).toMatchObject({ severity: 'blocker' });
    expect(checks.find((check) => check.id === 'runners.availability')).toBeUndefined();
    expect(report.status).toBe('blocked');
  });

  it('falls back to the no-claim notice when the probe itself fails', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      probeRunnerAvailability: async () => {
        throw new Error('probe exploded');
      },
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(checks.find((check) => check.id === 'runners.availability')).toMatchObject({
      severity: 'info',
      summary: 'Provider availability was not probed.',
    });
  });

  it('merges headless admission checks when interaction and probeRunnerAdmission are provided', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      interaction: 'headless',
      probeRunnerAdmission: async () => [
        {
          id: 'runners.preparation.planner',
          severity: 'blocker',
          summary: 'Planner could not be admitted.',
          fix: 'Pass --allow-unverified-auth to start anyway.',
        },
      ],
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(checks).toContainEqual(
      expect.objectContaining({
        id: 'runners.preparation.planner',
        severity: 'blocker',
        fix: 'Pass --allow-unverified-auth to start anyway.',
      }),
    );
  });
});

describe('preparation readiness projection', () => {
  it('replaces tool-level CLI placeholders with exact slot checks', async () => {
    const projectDir = createTempDir('collect-preparation-checks');
    try {
      const { report } = await collectReadiness({ projectDir, config: makeConfig() });
      const prepared = applyRunnerPreparationChecks(report, [
        {
          id: 'runners.preparation.planner',
          severity: 'ok',
          summary: 'Configured planner is freshly admitted.',
        },
      ]);
      const checks = flattenReadinessChecks(prepared.sections);

      expect(checks.some((check) => check.id.startsWith('runners.cli.'))).toBe(false);
      expect(checks).toContainEqual(
        expect.objectContaining({ id: 'runners.preparation.planner', severity: 'ok' }),
      );
      expect(prepared.counts.blocker).toBe(report.counts.blocker - 1);
    } finally {
      cleanupTempDir(projectDir);
    }
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

  it('counts only the operator edits in the dirty worktree, not the isolation worktree or state dir', async () => {
    createTestGitRepo(tempDir, { 'src/edited.ts': 'export const a = 1;\n' });
    writeFileSync(join(tempDir, 'src', 'edited.ts'), 'export const a = 2;\n');
    mkdirSync(join(tempDir, TREES_DIR, 'sess-1', 'src'), { recursive: true });
    writeFileSync(join(tempDir, TREES_DIR, 'sess-1', 'src', 'edited.ts'), 'export const a = 3;\n');
    mkdirSync(join(tempDir, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(join(tempDir, SPLITBRIEF_DIR, CONFIG_FILE), 'version: 3\n');

    const { report } = await collectReadiness({ projectDir: tempDir });

    const dirty = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'repo.dirty-worktree',
    );
    expect(dirty?.metadata).toEqual({ dirtyCount: 1, untrackedCount: 0 });
    expect(dirty?.details).toEqual(['Examples: src/edited.ts']);
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

  it('ignores only the explicit session being resumed', async () => {
    createTestGitRepo(tempDir);
    const sessionId = '2026-04-18-resume-session';
    writeSessionState(tempDir, sessionId, 'implementing');
    writeActive({ projectDir: tempDir, sessionId });

    const resumed = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      resumeSession: { projectDir: tempDir, sessionId },
    });
    const other = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      resumeSession: { projectDir: tempDir, sessionId: 'another-session' },
    });

    expect(
      flattenReadinessChecks(resumed.report.sections).some((check) =>
        check.id.startsWith('repo.active-session-'),
      ),
    ).toBe(false);
    expect(
      flattenReadinessChecks(other.report.sections).some((check) =>
        check.id.startsWith('repo.active-session-'),
      ),
    ).toBe(true);
  });
});

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('collectReadiness config loader warnings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-config-warnings');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function writeMinimalV3Config(projectDir: string): string {
    const filePath = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
    mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(
      filePath,
      [
        'version: 3',
        'planner:',
        '  kind: cli',
        '  tool: claude-code',
        'implementer:',
        '  kind: api',
        '  provider: ollama',
        '  api_base: http://localhost:11434/v1',
        '  model: qwen2.5-coder:7b',
      ].join('\n'),
    );
    return filePath;
  }

  itUnix('surfaces a 0666 permission warning exactly once', async () => {
    const configPath = writeMinimalV3Config(tempDir);
    chmodSync(configPath, 0o666);

    const { report } = await collectReadiness({ projectDir: tempDir });
    const configWarnings = flattenReadinessChecks(report.sections).filter(
      (check) => check.id === 'config.warning',
    );

    expect(configWarnings).toHaveLength(1);
    expect(configWarnings[0]?.summary).toContain('overly permissive');
  });

  it('reports an unsupported config version as a blocking invalid config', async () => {
    writeConfigYaml(tempDir, {
      version: 2,
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
      },
      workflow: {
        maxRetries: 3,
      },
    });

    const { report } = await collectReadiness({ projectDir: tempDir });
    const invalid = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'config.invalid',
    );

    expect(invalid?.severity).toBe('blocker');
    expect(invalid?.details?.[0]).toContain('Unsupported config version: 2');
  });
});
