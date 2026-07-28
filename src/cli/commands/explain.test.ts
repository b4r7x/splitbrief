import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { saveSummary } from '../../core/sessions/io.js';
import { writeActive } from '../../core/sessions/lifecycle.js';
import { taskId } from '../../core/schemas/task.js';
import { isCliError } from '../errors.js';
import { registerExplainCommand } from './explain.js';

const SESSION_ID = '2026-04-29-cli-explain';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('explain-command-test');
});

afterEach(() => {
  cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

async function runExplain(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerExplainCommand(program);
  await program.parseAsync(['node', 'splitbrief', 'explain', ...args]);
}

function writeSession(projectDir: string): void {
  ensureSessionDir(projectDir, SESSION_ID);
  const task = makeTask({ id: 'T001', title: 'CLI route task', status: 'done' });
  const state = {
    ...createInitialState('cli explain feature'),
    phase: 'complete' as const,
    tasks: [task],
    tokenUsage: makeUsage({ implementerInput: 1000, implementerOutput: 500 }),
  };
  const summary = makeSummary({
    feature: 'cli explain feature',
    totalTasks: 1,
    completedByLocal: 1,
    totalTime: 10_000,
    tokenUsage: state.tokenUsage,
    taskBreakdown: [
      {
        taskId: taskId('T001'),
        taskTitle: 'CLI route task',
        method: 'local',
        implementerTokens: 1000,
        escalationTokens: 0,
        retryCount: 0,
        implementerProfile: 'local-small',
        contextFit: 'fits',
        estimatedTokens: 1200,
      },
    ],
  });
  saveState({ projectDir, sessionId: SESSION_ID }, state);
  saveSummary(
    { projectDir: projectDir, sessionId: SESSION_ID },
    makeSession({ id: SESSION_ID, status: 'complete', summary }),
  );
  writeActive({ projectDir: projectDir, sessionId: SESSION_ID });
}

describe('explain command', () => {
  it('emits JSON for the active session without model calls', async () => {
    writeSession(tmp);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await runExplain(['--project', tmp, '--json']);

    const parsed = JSON.parse(writes.join('').trim()) as {
      type?: string;
      explain?: { sessionId?: string; routing?: Array<{ selectedProfile?: string }> };
    };
    expect(parsed.type).toBe('run_explain');
    expect(parsed.explain?.sessionId).toBe(SESSION_ID);
    expect(parsed.explain?.routing).toContainEqual(
      expect.objectContaining({ selectedProfile: 'local-small' }),
    );
  });

  it('prints compact human output for an explicit session', async () => {
    writeSession(tmp);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message) => {
      logs.push(String(message));
    });

    await runExplain(['--project', tmp, '--session', SESSION_ID]);

    const output = logs.join('\n');
    expect(output).toContain('Run explain');
    expect(output).toContain('T001 -> local-small');
    expect(output).toContain(`.splitbrief/sessions/${SESSION_ID}/summary.json`);
  });

  it('fails when neither --session nor active session is available', async () => {
    let captured: unknown;
    try {
      await runExplain(['--project', tmp]);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('--session');
  });
});
