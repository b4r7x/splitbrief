import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `diptych-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionDir(projectDir: string, sessionId: string): string {
  const sessDir = join(projectDir, '.diptych', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function writeLockfile(sessDir: string, overrides: Record<string, unknown> = {}): void {
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: Date.now(),
    lastAliveMs: Date.now(),
    sessionId: 'test-session',
    mode: 'standard',
    feature: 'test-feature',
    ...overrides,
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function writeState(sessDir: string, phase: string, extra: Record<string, unknown> = {}): void {
  const state = {
    stateVersion: 3,
    phase,
    feature: 'test-feature',
    currentTaskIndex: 0,
    attempt: 0,
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    },
    tasks: [
      {
        id: 'T001',
        title: 'task-1',
        action: 'create',
        file: 'src/test.ts',
        dependsOn: [],
        description: 'Test task',
        tests: [],
        constraints: [],
        typeDefs: '',
        implementationSteps: [],
        status: 'pending',
      },
    ],
    awaitingContinue: false,
    ...extra,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

// Only mock the render layer (UI boundary) and deps that produce side effects
// beyond the fs: initStores, renderApp, headless, crash-diagnostic, setupWorkflow.
vi.mock('../../app.js', () => ({ App: () => null }));
vi.mock('../render.js', () => ({ renderApp: vi.fn() }));
vi.mock('../init-stores.js', () => ({ initStores: vi.fn() }));
vi.mock('../headless.js', () => ({ runHeadless: vi.fn() }));
vi.mock('../../engine/ipc/crash-diagnostic.js', () => ({
  showCrashDiagnostic: vi.fn(),
}));

describe('continueCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when no session exists and no active pointer', async () => {
    const { continueCommand } = await import('./continue.js');
    const projectDir = makeTmpProject();

    await expect(
      continueCommand(undefined, { projectDir } as never),
    ).rejects.toThrow(/no session to continue/);
  });

  it('throws when explicit session ID has no state and is not running', async () => {
    const { continueCommand } = await import('./continue.js');
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-my-feature');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-my-feature' });

    await expect(
      continueCommand('2025-04-01-my-feature', { projectDir } as never),
    ).rejects.toThrow(/no saved state and is not running/);
  });

  it('throws for a completed session that is not resumable', async () => {
    const { continueCommand } = await import('./continue.js');
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-done');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-done' });
    writeState(sessDir, 'complete');

    await expect(
      continueCommand('2025-04-01-done', { projectDir } as never),
    ).rejects.toThrow(/cannot be resumed/);
  });

  it('resolveSessionInput returns undefined for undefined input', async () => {
    const { resolveSessionInput } = await import('./continue.js');
    await expect(resolveSessionInput(undefined, '/tmp')).resolves.toBeUndefined();
  });

  it('resolveSessionInput passes through string IDs', async () => {
    const { resolveSessionInput } = await import('./continue.js');
    await expect(resolveSessionInput('2025-04-01-feat', '/tmp')).resolves.toBe('2025-04-01-feat');
  });
});
