import { createSteeringPort, deliverToRunningCall, type SteerOutcome } from '../calls/steering.js';
import { installClaudeSteeringShim } from '#testing/helpers/claude-steering-shim.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCliPlanner as createCliPlannerImpl } from './cli.js';
import { makeConfig as makeBaseConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { prependPath, trustedShimGate, writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../lib/process/errors.js';
import { TASKS_FILE } from '../../core/paths.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { CLI_RAW_OUTPUT_MAX_BYTES } from '../runners/cli-tools/process-invoke.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { PlannerFactoryOptions } from './types.js';
import { callPlanner } from '#testing/helpers/planner-call.js';
import { z } from 'zod';
import { requestTyped } from '../runners/typed-output.js';
import {
  makeBusRecorder,
  makeCallbacks,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { saveState } from '../../core/state/persistence.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { runPlanningPhase } from '../orchestrator/planning/run.js';

const invokeCliAdapterDeadlines = vi.hoisted(() => [] as Array<number | undefined>);

vi.mock('../runners/invoke-cli-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runners/invoke-cli-adapter.js')>();
  return {
    ...actual,
    invokeCliAdapter: (opts: Parameters<typeof actual.invokeCliAdapter>[0]) => {
      invokeCliAdapterDeadlines.push(opts.invocation.timeoutMs);
      return actual.invokeCliAdapter(opts);
    },
  };
});

const schemaFileWrites = vi.hoisted(() => ({ count: 0 }));

vi.mock('../runners/schema-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runners/schema-file.js')>();
  return {
    withSchemaFile: (...args: Parameters<typeof actual.withSchemaFile>) => {
      schemaFileWrites.count++;
      return actual.withSchemaFile(...args);
    },
  };
});

function makeConfig(overrides: Parameters<typeof makeBaseConfig>[0] = {}) {
  const implementer = overrides.implementer;
  return makeBaseConfig({
    ...overrides,
    implementer:
      implementer?.kind !== undefined && implementer.kind !== 'api'
        ? implementer
        : { service: 'ollama', offering: 'local', ...implementer },
  });
}

/**
 * CLI planner is a thin wrapper around a real subprocess. Instead of mocking
 * the subprocess seam, we install a shell shim on PATH that emits the exact
 * JSONL / JSON lines the planner's parser expects. This exercises the real
 * spawn pipeline from top to bottom: createCliPlanner → spawnAndCollect →
 * spawnWithStdin → child_process → parseLine → accumulated text/usage.
 */

let projectDir: string;
let shimDir: string;
let restorePath: () => void;
const itUnix = process.platform === 'win32' ? it.skip : it;

function createCliPlanner(
  config: Parameters<typeof createCliPlannerImpl>[0]['config'],
  initialSessionId?: string | null,
  options?: PlannerFactoryOptions,
): ReturnType<typeof createCliPlannerImpl> {
  const tool = config.planner.kind === 'cli' ? config.planner.tool : null;
  if (tool === null) throw new Error('test helper requires a CLI planner config');
  return createCliPlannerImpl({
    config,
    initialSessionId,
    ...options,
    trustedCli: options?.trustedCli ?? trustedShimGate({ dir: shimDir, tool }),
  });
}

const CODEX_TURN_COMPLETED = JSON.stringify({ type: 'turn.completed' });

function codexLines(lines: string[]): string[] {
  const hasTerminal = lines.some((line) => {
    try {
      return (JSON.parse(line) as { type?: string }).type === 'turn.completed';
    } catch {
      return false;
    }
  });
  return hasTerminal ? lines : [...lines, CODEX_TURN_COMPLETED];
}

function installShim(command: string, bodyLines: string[]): void {
  writeCommandShim({
    dir: shimDir,
    command,
    lines: command === 'codex' ? codexLines(bodyLines) : bodyLines,
  });
}

function installRecordingShim(command: string, bodyLines: string[]): { argvFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const shimPath = join(shimDir, command);
  const lines = command === 'codex' ? codexLines(bodyLines) : bodyLines;
  const body = lines.map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(shimPath, `#!/bin/bash\nprintf '%s\\n' "$@" > '${argvFile}'\n${body}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile };
}

function installDirectWriteRecordingShim(
  command: string,
  bodyLines: string[],
  mutatedFile = 'src/hello.ts',
): {
  argvFile: string;
} {
  const argvFile = join(shimDir, 'argv.txt');
  const shimPath = join(shimDir, command);
  const output = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(
    shimPath,
    `#!/bin/bash
printf '%s\\n' "$@" > '${argvFile}'
mkdir -p "$PWD/${dirname(mutatedFile)}"
printf '%s\\n' 'export const escalated = true;' > "$PWD/${mutatedFile}"
${output}
`,
    'utf8',
  );
  chmodSync(shimPath, 0o755);
  return { argvFile };
}

function readArgv(argvFile: string): string[] {
  return readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
}

beforeEach(() => {
  projectDir = createTempDir('cli-planner-project');
  createTestGitRepo(projectDir);
  shimDir = createTempDir('cli-planner-shim');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  cleanupTempDir(projectDir);
  cleanupTempDir(shimDir);
});

describe('createCliPlanner', () => {
  it('isAvailable returns true when the CLI responds to --version', async () => {
    installShim('codex', ['codex 1.0.0']);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));

    expect(await planner.isAvailable()).toBe(true);
  });

  it('refuses an explicitly selected unproven API-key channel before spawning a planner process', async () => {
    const envFile = join(shimDir, 'env.txt');
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `printf '%s|%s|%s' "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$HOME" > '${envFile}'`,
        `printf '%s\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const originalOpenAi = process.env.OPENAI_API_KEY;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    try {
      const planner = createCliPlanner(
        makeConfig({
          planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
        }),
      );

      await expect(
        planner.review('prompt', projectDir, { onOutput: vi.fn() }),
      ).rejects.toMatchObject({ kind: 'runner-auth-channel-unenforced' });
      expect(existsSync(envFile)).toBe(false);
    } finally {
      if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  });

  it('streams every known-CLI text event as output', async () => {
    const chunks = ['Which ', 'scope?', ' Which scope?'];
    installShim(
      'opencode',
      chunks.map((text) =>
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-open',
          part: { type: 'text', text },
        }),
      ),
    );
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const onOutput = vi.fn();

    await callPlanner(planner, { prompt: 'prompt', projectDir, callbacks: { onOutput } });

    expect(onOutput.mock.calls.flat()).toEqual(chunks);
  });

  it('capabilities: supportsSessionResume mirrors the tool config (codex yes, opencode no)', () => {
    const withResume = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    expect(withResume.capabilities.supportsSessionResume).toBe(true);

    const noResume = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    expect(noResume.capabilities.supportsSessionResume).toBe(false);
  });

  it('captures a session id emitted via stream-json thread.started and forwards it to onSessionId', async () => {
    // Codex planner uses JSONL. `thread.started` is parsed as sessionId.
    // Emit a minimal spec/plan/tasks plus thread.started; plan() is the path
    // that propagates onSessionId (review()'s callback type is narrower).
    installShim('codex', [
      JSON.stringify({ type: 'thread.started', thread_id: 'sess-abc' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '# spec\nbody' },
      }),
    ]);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const onSessionId = vi.fn();

    await callPlanner(planner, {
      prompt: 'add auth',
      projectDir,
      callbacks: { onOutput: vi.fn(), onSessionId },
    });

    expect(onSessionId).toHaveBeenCalledWith('sess-abc');
  });

  it('resumes the thread id codex reported, never the SPLITBRIEF session id', async () => {
    const { argvFile } = installRecordingShim('codex', [
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '# Research\nbody' },
      }),
    ]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const callbacks = { onOutput: vi.fn() };

    await callPlanner(planner, { projectDir, callbacks });
    const firstArgv = readArgv(argvFile);
    expect(firstArgv).not.toContain('codex-thread-1');
    expect(firstArgv).not.toContain('splitbrief-session');

    await callPlanner(planner, { projectDir, callbacks });
    const secondArgv = readArgv(argvFile);
    expect(secondArgv).toContain('codex-thread-1');
    expect(secondArgv).not.toContain('splitbrief-session');
  });

  // Codex 0.157.1 writes no rollout for an `--ephemeral` exec, and `exec resume` of that
  // thread then fails before any turn with this exact line (captured live 2026-09-29).
  it('keeps the thread a fresh call reports resumable, so the next call continues it', async () => {
    const rollouts = createTempDir('codex-rollouts');
    const shimPath = join(shimDir, 'codex');
    const reply = (text: string) =>
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        'if [[ " $* " == *" resume "* ]]; then',
        `  thread="$(printf '%s\\n' "$@" | tail -n 2 | head -n 1)"`,
        `  if [[ ! -f '${rollouts}'/"$thread" ]]; then`,
        '    printf \'Error: thread/resume: thread/resume failed: no rollout found for thread id %s (code -32600)\\n\' "$thread" >&2',
        '    exit 1',
        '  fi',
        `  printf '%s\\n' "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"$thread\\"}"`,
        `  printf '%s\\n' '${reply('# Spec\nbody')}'`,
        'else',
        `  if [[ " $* " != *" --ephemeral "* ]]; then touch '${rollouts}/codex-thread-1'; fi`,
        `  printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' })}'`,
        `  printf '%s\\n' '${reply('# Research\nbody')}'`,
        'fi',
        `printf '%s\\n' '${CODEX_TURN_COMPLETED}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const callbacks = { onOutput: vi.fn() };

    try {
      await callPlanner(planner, { projectDir, callbacks });
      const resumed = await callPlanner(planner, { projectDir, callbacks });

      expect(resumed.text).toBe('# Spec\nbody');
    } finally {
      cleanupTempDir(rollouts);
    }
  });

  it('runs review calls one-shot and ephemeral, and keeps the planner thread for planning', async () => {
    const spawnLog = join(shimDir, 'codex-spawns.txt');
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        'thread=codex-one-shot-thread',
        'if [[ " $* " == *" resume "* ]]; then',
        `  thread="$(printf '%s\\n' "$@" | tail -n 2 | head -n 1)"`,
        `  printf 'resume %s\\n' "$thread" >> '${spawnLog}'`,
        'elif [[ " $* " == *" --ephemeral "* ]]; then',
        `  printf 'fresh ephemeral\\n' >> '${spawnLog}'`,
        'else',
        `  printf 'fresh\\n' >> '${spawnLog}'`,
        'fi',
        `printf '%s\\n' "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"$thread\\"}"`,
        `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Use a default.' } })}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      'sess-planning',
    );

    await planner.review('review the run', projectDir, { onOutput: vi.fn() });
    await planner.review('review the run again', projectDir, { onOutput: vi.fn() });
    await callPlanner(planner, {
      prompt: 'revise the spec',
      projectDir,
      callbacks: { onOutput: vi.fn() },
    });
    await callPlanner(planner, { projectDir, callbacks: { onOutput: vi.fn() } });
    const threadless = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    await callPlanner(threadless, { projectDir, callbacks: { onOutput: vi.fn() } });

    expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toEqual([
      'fresh ephemeral',
      'fresh ephemeral',
      'resume sess-planning',
      'resume sess-planning',
      'fresh',
    ]);
  });

  it('fails a resumed call whose session expired without a fresh-session fallback', async () => {
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `if printf '%s\\n' "$@" | grep -q '^sess-old$'; then`,
        "  printf '%s\\n' 'session not found: sess-old' >&2",
        '  exit 1',
        'fi',
        `printf '%s\\n' '${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'unexpected fresh-session attempt' },
        }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const events: RunnerCallEvent[] = [];
    const onSessionExpired = vi.fn();
    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      'sess-old',
    );

    await expect(
      callPlanner(planner, {
        prompt: 'fallback',
        projectDir,
        callbacks: {
          onOutput: vi.fn(),
          onSessionExpired,
          onCallEvent: (event) => events.push(event),
        },
      }),
    ).rejects.toMatchObject({ kind: 'session-resume-expired' });

    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(events.filter((event) => event.type === 'call_started')).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'call_completed' }));
  });

  it('expires a codex thread whose rollout is gone, so the next call starts a fresh thread', async () => {
    const argvLog = join(shimDir, 'argv.log');
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        `printf '%s ' "$@" >> '${argvLog}'`,
        `printf '\\n' >> '${argvLog}'`,
        'if [[ " $* " == *" resume "* ]]; then',
        `  thread="$(printf '%s\\n' "$@" | tail -n 2 | head -n 1)"`,
        '  printf \'Error: thread/resume: thread/resume failed: no rollout found for thread id %s (code -32600)\\n\' "$thread" >&2',
        '  exit 1',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-new' })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '# Spec\nbody' } })}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const events: RunnerCallEvent[] = [];
    const onSessionExpired = vi.fn();
    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      'codex-thread-gone',
    );
    const callbacks = {
      onOutput: vi.fn(),
      onSessionExpired,
      onCallEvent: (event: RunnerCallEvent) => events.push(event),
    };

    await expect(callPlanner(planner, { projectDir, callbacks })).rejects.toMatchObject({
      kind: 'session-resume-expired',
    });
    expect(onSessionExpired).toHaveBeenCalledWith('codex-thread-gone');
    expect(events.filter((event) => event.type === 'call_started')).toHaveLength(1);

    const rerun = await callPlanner(planner, { projectDir, callbacks });

    expect(rerun.text).toBe('# Spec\nbody');
    const [expired, fresh] = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(expired).toContain(' resume ');
    expect(expired).toContain('codex-thread-gone');
    expect(fresh).not.toContain(' resume ');
    expect(fresh).not.toContain('codex-thread-gone');
  });

  it('rejects a resumed call whose returned Codex thread id differs, without a fresh attempt', async () => {
    const tasksMarkdown = `---
id: T001
title: Fallback after thread mismatch
action: create
file: src/mismatch.ts
depends_on: []
---

### Description
Create the mismatch fallback file.

### Tests
- fallback attempt succeeds
`;
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `if printf '%s\\n' "$@" | grep -q '^sess-old$'; then`,
        `  printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'sess-new-unexpected' }).replace(/'/g, "'\\''")}'`,
        `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: tasksMarkdown } }).replace(/'/g, "'\\''")}'`,
        `  printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '  exit 0',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'sess-fresh' }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: tasksMarkdown } }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const events: RunnerCallEvent[] = [];
    const onSessionId = vi.fn();
    const onSessionExpired = vi.fn();
    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      'sess-old',
    );

    await expect(
      callPlanner(planner, {
        prompt: 'fallback',
        projectDir,
        callbacks: {
          onOutput: vi.fn(),
          onSessionId,
          onSessionExpired,
          onCallEvent: (event) => events.push(event),
        },
      }),
    ).rejects.toMatchObject({ kind: 'session-resume-mismatch' });

    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'call_started')).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'call_session_id', nativeSessionId: 'sess-fresh' }),
    );
  });

  it('runs Codex write-files full escalation once without replacing the planning session', async () => {
    const spawnLog = join(shimDir, 'codex-spawns.txt');
    const writerArgvFile = join(shimDir, 'codex-writer-argv.txt');
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        "if printf '%s\\n' \"$@\" | grep -q '^--skip-git-repo-check$'; then",
        `  printf '%s\\n' 'writer' >> '${spawnLog}'`,
        `  printf '%s\\n' "$@" > '${writerArgvFile}'`,
        '  mkdir -p "$PWD/src"',
        `  printf '%s\\n' 'export const escalated = true;' > "$PWD/src/hello.ts"`,
        `  printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'sess-writer' }).replace(/'/g, "'\\''")}'`,
        `  printf '%s\\n' '${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Wrote src/hello.ts.' },
        }).replace(/'/g, "'\\''")}'`,
        `  printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '  exit 0',
        'fi',
        "if printf '%s\\n' \"$@\" | grep -q '^sess-planning$'; then",
        `  printf '%s\\n' 'resume-planning' >> '${spawnLog}'`,
        'else',
        `  printf '%s\\n' 'resume-other' >> '${spawnLog}'`,
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'sess-planning' }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Review complete.' },
        }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      'sess-planning',
    );

    const result = await planner.escalateFull({
      task: makeTask(),
      error: 'initial implementation failed',
      projectDir,
      callbacks: { onOutput: vi.fn() },
    });

    expect(result).toMatchObject({ success: true, code: null });
    expect(readFileSync(join(projectDir, 'src', 'hello.ts'), 'utf8')).toBe(
      'export const escalated = true;\n',
    );
    expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toEqual(['writer']);
    expect(readArgv(writerArgvFile)).not.toContain('resume');
    expect(readArgv(writerArgvFile)).not.toContain('sess-planning');
    expect(readArgv(writerArgvFile)).toContain('--ephemeral');

    await callPlanner(planner, { projectDir, callbacks: { onOutput: () => {} } });

    expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toEqual([
      'writer',
      'resume-planning',
    ]);
  });

  it.each([
    {
      tool: 'opencode',
      command: 'opencode',
      output: JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: 'Wrote src/hello.ts.' },
      }),
      requiredArgs: ['run', '--format', 'json', '--agent', 'build'],
      forbiddenArgs: ['plan'],
    },
    {
      tool: 'copilot',
      command: 'copilot',
      output: JSON.stringify({
        type: 'assistant.message',
        data: { text: 'Wrote src/hello.ts.' },
      }),
      requiredArgs: ['-p', '--output-format', 'json', '--allow-all', '--no-ask-user'],
      forbiddenArgs: ['--plan', '--allow-all-tools'],
    },
    {
      tool: 'kilo-code',
      command: 'kilo',
      output: JSON.stringify({
        type: 'text',
        sessionID: 'ses-kilo',
        part: { type: 'text', text: 'Wrote src/hello.ts.' },
      }),
      requiredArgs: ['run', '--format', 'json', '--agent', 'code', '--auto'],
      forbiddenArgs: ['plan'],
    },
  ] satisfies readonly {
    tool: CliToolId;
    command: string;
    output: string;
    requiredArgs: readonly string[];
    forbiddenArgs: readonly string[];
  }[])(
    '$tool uses its direct-write planner posture only for tier-2 full escalation',
    async ({ tool, command, output, requiredArgs, forbiddenArgs }) => {
      const { argvFile } = installDirectWriteRecordingShim(command, [output]);
      const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool } }));

      const result = await planner.escalateFull({
        task: makeTask(),
        error: 'initial implementation failed',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      });

      expect(result).toMatchObject({ success: true, code: null });
      expect(readFileSync(join(projectDir, 'src', 'hello.ts'), 'utf8')).toBe(
        'export const escalated = true;\n',
      );
      const argv = readArgv(argvFile);
      for (const requiredArg of requiredArgs) expect(argv).toContain(requiredArg);
      for (const forbiddenArg of forbiddenArgs) expect(argv).not.toContain(forbiddenArg);
      expect(argv.some((arg) => arg.includes('Make the changes on disk'))).toBe(true);
    },
  );

  it.each(['review', 'summarize', 'summarizeStructured'] as const)(
    'keeps OpenCode %s read-only and rejects source mutations',
    async (operation) => {
      const output = JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: 'Read-only response.' },
      });
      const { argvFile } = installDirectWriteRecordingShim('opencode', [output]);
      const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

      let invocation: Promise<unknown>;
      switch (operation) {
        case 'review':
          invocation = planner.review('review the change', projectDir, { onOutput: vi.fn() });
          break;
        case 'summarize':
          invocation = planner.summarize([{ role: 'user', text: 'summarize this' }], {
            projectDir,
          });
          break;
        case 'summarizeStructured':
          if (planner.summarizeStructured === undefined) {
            throw new Error('CLI planner must support structured summaries');
          }
          invocation = planner.summarizeStructured([{ role: 'user', text: 'summarize this' }], {
            projectDir,
          });
          break;
      }

      await expect(invocation).rejects.toMatchObject({
        kind: 'planning-unexpected-mutations',
        data: { files: ['src/hello.ts'] },
      });
      const argv = readArgv(argvFile);
      expect(argv).toContain('--agent');
      expect(argv).toContain('plan');
    },
  );

  it('keeps planning read-only and rejects source mutations', async () => {
    const output = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: 'Planning response.' },
    });
    const { argvFile } = installDirectWriteRecordingShim('opencode', [output]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const callbacks = { onOutput: () => {} };

    await expect(
      callPlanner(planner, { prompt: 'plan a change', projectDir, callbacks }),
    ).rejects.toMatchObject({
      kind: 'planning-unexpected-mutations',
      data: { files: ['src/hello.ts'] },
    });
    expect(readArgv(argvFile)).toEqual(
      expect.arrayContaining(['run', '--format', 'json', '--agent', 'plan']),
    );
  });

  it('halts the planning session when the CLI planner writes the project', async () => {
    const output = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: 'Planning response.' },
    });
    installDirectWriteRecordingShim('opencode', [output]);
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'opencode' },
      codebase: { enabled: false, tokenBudget: 4000 },
    });
    const sessionId = 'mutating-planner';
    ensureSessionDir(projectDir, sessionId);
    const state = transition(createInitialState('greet people'), { type: 'START' });
    saveState({ projectDir, sessionId }, state);

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner: createCliPlanner(config),
      state,
      feature: 'greet people',
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(JSON.stringify(result.state.pendingRecovery)).toContain('src/hello.ts');
  });

  it('completes planning when OpenCode regenerates its own .opencode plugin state', async () => {
    const output = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: JSON.stringify({ result: makePlanProposal() }) },
    });
    installDirectWriteRecordingShim('opencode', [output], '.opencode/package-lock.json');
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'opencode' },
      codebase: { enabled: false, tokenBudget: 4000 },
      workflow: { approve: 'none' },
    });
    const sessionId = 'opencode-internal-state';
    ensureSessionDir(projectDir, sessionId);
    const state = transition(createInitialState('greet people'), { type: 'START' });
    saveState({ projectDir, sessionId }, state);

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner: createCliPlanner(config),
      state,
      feature: 'greet people',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.pendingRecovery).toBeUndefined();
  });

  it('rejects OpenCode writes to user-authored .opencode config despite the internal-state exemption', async () => {
    const output = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: 'Planning response.' },
    });
    installDirectWriteRecordingShim('opencode', [output], '.opencode/plugin/injected.js');
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const callbacks = { onOutput: () => {} };

    await expect(
      callPlanner(planner, { prompt: 'plan a change', projectDir, callbacks }),
    ).rejects.toMatchObject({
      kind: 'planning-unexpected-mutations',
      data: { files: ['.opencode/plugin/injected.js'] },
    });
  });

  it('rejects a typed truncated call and reaps OpenCode when stdout exceeds its budget', async () => {
    const pidFile = join(shimDir, 'opencode-pids.json');
    const shimPath = join(shimDir, 'opencode');
    const script = [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
      "process.stdout.write('OpenCode response text\\n');",
      "const frame = 'x'.repeat(999_999) + '\\n';",
      `setTimeout(() => { for (let i = 0; i < ${Math.ceil(CLI_RAW_OUTPUT_MAX_BYTES / 1_000_000) + 2}; i += 1) process.stdout.write(frame); }, 25);`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const events: RunnerCallEvent[] = [];

    await expect(
      planner.review('prompt', projectDir, {
        onOutput: vi.fn(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        role: 'review',
        backendKind: 'cli',
        status: 'truncated',
        partial: true,
        error: {
          code: 'output-budget-breach',
          message: expect.stringContaining('more than 64 MB'),
        },
      },
    });

    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_error',
        status: 'truncated',
        partial: true,
        error: { code: 'output-budget-breach', message: expect.any(String) },
      }),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'call_completed' }));
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  it('does not ingest a root tasks.md that an agentic CLI only described in prose', async () => {
    // Real prose from the 2026-08-06 first run: the planner wrote tasks.md to the
    // project root and said `Wrote \`tasks.md\`` in backticks — no markdown link.
    const realProse = [
      'Wrote `tasks.md` with two dependency-ordered briefs:',
      '',
      '- **T001** — create `src/text.ts` with `export function titleCase(input: string): string`, modeled on the single-pure-function style of `src/slug.ts` (regex replace uppercasing the first letter of each word).',
      "- **T002** (depends on T001) — create `src/text.test.ts` with vitest tests mirroring `src/slug.test.ts` (ESM `./text.js` import, `describe`/`it`/`expect`), covering `'hello world'` → `'Hello World'`, single word, and empty string.",
      '',
      "Each brief is self-contained with the existing code patterns inlined, In/Out-of-bounds scope, escalation triggers (e.g. stop if edge-case behavior becomes load-bearing or if T001's export is missing), and evidence requirements (`npm test` and `npm run typecheck` passing).",
    ].join('\n');
    const realTasksMd = `# Task Briefs: titleCase function

---
id: T001
title: Create titleCase function in src/text.ts
action: create
file: src/text.ts
depends_on: []
---

### Description
Create a new file \`src/text.ts\` exporting a \`titleCase\` function.

### Tests
- \`titleCase('hello world')\` → \`'Hello World'\`

---
id: T002
title: Add vitest tests for titleCase in src/text.test.ts
action: create
file: src/text.test.ts
depends_on: [T001]
---

### Description
Create \`src/text.test.ts\` with vitest tests for the \`titleCase\` function created in T001.

### Tests
- \`expect(titleCase('hello world')).toBe('Hello World')\`
`;
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `cat > "$PWD/${TASKS_FILE}" <<'TASKS_EOF'`,
        realTasksMd,
        'TASKS_EOF',
        `cat <<'JSON_EOF'`,
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: realProse },
        }),
        CODEX_TURN_COMPLETED,
        'JSON_EOF',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));

    await expect(
      callPlanner(planner, {
        prompt: 'add a titleCase function',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      }),
    ).rejects.toMatchObject({
      kind: 'planning-unexpected-mutations',
      data: { files: [TASKS_FILE] },
    });
  });
  it('rejects with a not-found error when the CLI binary is missing from PATH', async () => {
    // Admit the actual shim identity, then remove the executable before the
    // launch. The start gate must not fall back to an ambient PATH entry.
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    unlinkSync(join(shimDir, 'codex'));
    process.env['PATH'] = createTempDir('empty-path');

    try {
      await expect(planner.review('prompt', projectDir, { onOutput: vi.fn() })).rejects.toSatisfy(
        processError.isNotFound,
      );
    } finally {
      cleanupTempDir(process.env['PATH']!);
    }
  });

  it('appends cfg.args to the tool argv when planner.args is set', async () => {
    const { argvFile } = installRecordingShim('codex', [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'response' },
      }),
    ]);

    const planner = createCliPlanner(
      makeConfig({
        planner: { kind: 'cli', tool: 'codex', args: ['--reasoning', 'high'] },
      }),
    );

    await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    const argv = readArgv(argvFile);
    expect(argv.slice(-2)).toEqual(['--reasoning', 'high']);
  });

  it('passes a configured variant through to the opencode planner argv', async () => {
    const { argvFile } = installRecordingShim('opencode', [
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: 'response' },
      }),
    ]);

    const planner = createCliPlanner(
      makeConfig({
        planner: {
          kind: 'cli',
          tool: 'opencode',
          model: 'openai/gpt-5.6-luna',
          variant: 'xhigh',
        },
      }),
    );

    await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    const argv = readArgv(argvFile);
    expect(argv.slice(argv.indexOf('--variant'), argv.indexOf('--variant') + 2)).toEqual([
      '--variant',
      'xhigh',
    ]);
  });

  it('a claude-code planner ignores a stray variant', async () => {
    const { argvFile } = installRecordingShim('claude', [
      JSON.stringify({ type: 'result', result: 'response' }),
    ]);

    const withoutVariant = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } }),
    );
    await withoutVariant.review('prompt', projectDir, { onOutput: vi.fn() });
    const baseline = readArgv(argvFile);

    const withVariant = createCliPlanner(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet', variant: 'xhigh' },
      }),
    );
    await withVariant.review('prompt', projectDir, { onOutput: vi.fn() });

    expect(readArgv(argvFile)).toEqual(baseline);
    expect(baseline).not.toContain('--variant');
  });

  it.each([
    ['auto', undefined],
    ['AUTO', undefined],
    ['  auto  ', undefined],
    [undefined, undefined],
    ['gpt-5.4', 'gpt-5.4'],
  ])('spawns codex with model %j resolved to %j', async (model, expected) => {
    const { argvFile } = installRecordingShim('codex', [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'response' },
      }),
    ]);

    const planner = createCliPlanner(
      makeConfig({
        planner: { kind: 'cli', tool: 'codex', ...(model === undefined ? {} : { model }) },
      }),
    );

    await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    const argv = readArgv(argvFile);
    if (expected === undefined) {
      expect(argv).not.toContain('--model');
    } else {
      expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual([
        '--model',
        expected,
      ]);
    }
  });

  it('keeps the legacy Claude Code "default" alias from reaching argv as a model id', async () => {
    const { argvFile } = installRecordingShim('claude', [
      JSON.stringify({ type: 'result', result: 'response' }),
    ]);

    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'default' } }),
    );

    await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    expect(readArgv(argvFile)).not.toContain('--model');
  });

  it('keeps the tool-default parser despite a configured outputFormat', async () => {
    // The adapter's own parser is authoritative: configuring outputFormat: 'text'
    // on a codex planner must not switch parsing, so a JSONL result still parses
    // as a structured record instead of becoming the raw line as text.
    installShim('codex', [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'response' },
      }),
    ]);

    const planner = createCliPlanner(
      makeConfig({
        planner: { kind: 'cli', tool: 'codex', outputFormat: 'text' },
      }),
    );

    const result = await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    expect(result.text).toBe('response');
  });

  it('gives same-input retries and concurrent identical runs distinct attempt identities', async () => {
    installShim('codex', [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'response' },
      }),
    ]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const secondDir = createTempDir('cli-planner-attempt-identity');
    createTestGitRepo(secondDir);
    try {
      const first: RunnerCallEvent[] = [];
      const second: RunnerCallEvent[] = [];

      await Promise.all([
        planner.review('same prompt', projectDir, {
          onOutput: vi.fn(),
          onCallEvent: (event) => first.push(event),
        }),
        planner.review('same prompt', secondDir, {
          onOutput: vi.fn(),
          onCallEvent: (event) => second.push(event),
        }),
      ]);
      await planner.review('same prompt', projectDir, {
        onOutput: vi.fn(),
        onCallEvent: (event) => first.push(event),
      });

      const attemptIds = [...first, ...second]
        .filter((event) => event.type === 'call_started')
        .map((event) => event.attemptId);
      expect(attemptIds).toHaveLength(3);
      expect(new Set(attemptIds).size).toBe(3);
    } finally {
      cleanupTempDir(secondDir);
    }
  });

  it('cli planner threads idle defaults and config overrides into the spawn', async () => {
    installShim('codex', [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'fast response' },
      }),
    ]);
    const defaultEvents: RunnerCallEvent[] = [];
    const defaultPlanner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
    );

    const defaultResult = await defaultPlanner.review('prompt', projectDir, {
      onOutput: vi.fn(),
      onCallEvent: (event) => defaultEvents.push(event),
    });

    expect(defaultResult.text).toContain('fast response');
    expect(defaultEvents.some((event) => event.type === 'call_stalled')).toBe(false);

    writeCommandShim({
      dir: shimDir,
      command: 'codex',
      lines: codexLines([
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'slow response' },
        }),
      ]),
      sleepSeconds: 0.15,
    });

    const overrideEvents: RunnerCallEvent[] = [];
    const overridePlanner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex', idleWarnMs: 30 } }),
    );

    const overrideResult = await overridePlanner.review('prompt', projectDir, {
      onOutput: vi.fn(),
      onCallEvent: (event) => overrideEvents.push(event),
    });

    expect(overrideResult.text).toContain('slow response');
    const stalled = overrideEvents.find((event) => event.type === 'call_stalled');
    expect(stalled).toMatchObject({ type: 'call_stalled', silentMs: expect.any(Number) });
  });
});

describe('seat deadlines', () => {
  itUnix(
    'neither the reviewer nor the planner seat has a default deadline; a configured timeout reaches both',
    async () => {
      installShim('opencode', [
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-open',
          part: { type: 'text', text: 'response' },
        }),
      ]);
      const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

      invokeCliAdapterDeadlines.length = 0;
      await planner.review('prompt', projectDir, { onOutput: vi.fn() });

      expect(invokeCliAdapterDeadlines).toEqual([undefined]);

      invokeCliAdapterDeadlines.length = 0;
      await callPlanner(planner, {
        prompt: 'plan a change',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      });

      expect(invokeCliAdapterDeadlines).toEqual([undefined]);

      const bounded = createCliPlanner(
        makeConfig({ planner: { kind: 'cli', tool: 'opencode', timeout: 45_000 } }),
      );
      invokeCliAdapterDeadlines.length = 0;
      await bounded.review('prompt', projectDir, { onOutput: vi.fn() });
      await callPlanner(bounded, {
        prompt: 'plan a change',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      });

      expect(invokeCliAdapterDeadlines).toEqual([45_000, 45_000]);
    },
  );
});

describe('createCliPlanner — typed calls', () => {
  itUnix('passes a private schema file to codex for a typed call and removes it', async () => {
    const argvFile = join(shimDir, 'argv.txt');
    const schemaCopy = join(shimDir, 'schema-copy.json');
    const modeFile = join(shimDir, 'mode.txt');
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `printf '%s\\n' "$@" > '${argvFile}'`,
        'schema=""',
        'previous=""',
        'for arg in "$@"; do',
        '  if [[ "$previous" == "--output-schema" ]]; then schema="$arg"; fi',
        '  previous="$arg"',
        'done',
        `cp "$schema" '${schemaCopy}'`,
        `ls -l "$schema" > '${modeFile}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'sess-typed-schema' })}'`,
        `printf '%s\\n' '${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"answer":"x","count":1}' },
        }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const result = await planner
      .typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'reviewer' })
      .invoke({
        prompt: 'q',
        schema: {
          json: { type: 'object', properties: {}, required: [], additionalProperties: false },
          name: 'probe',
        },
      });

    expect(result.status).toBe('completed');
    const argv = readArgv(argvFile);
    expect(argv).toContain('--output-schema');
    const schemaPath = argv[argv.indexOf('--output-schema') + 1];
    if (schemaPath === undefined) throw new Error('codex argv recorded no schema path');
    expect(readFileSync(schemaCopy, 'utf8')).toBe(
      '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
    );
    expect(readFileSync(modeFile, 'utf8')).toMatch(/^-rw-------/);
    expect(existsSync(schemaPath)).toBe(false);
  });

  itUnix('gives antigravity its schema inline and writes no schema file', async () => {
    const fixture = readFileSync(
      join(process.cwd(), 'testing/fixtures/typed-output/antigravity-1.2.14.jsonl'),
      'utf8',
    );
    const { argvFile } = installRecordingShim('agy', fixture.trimEnd().split('\n'));
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'antigravity' } }));
    schemaFileWrites.count = 0;

    const result = await planner
      .typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'reviewer' })
      .invoke({ prompt: 'q', schema: { json: { type: 'object' }, name: 'probe' } });

    expect(result.status).toBe('completed');
    const argv = readArgv(argvFile);
    expect(argv).toContain('--json-schema');
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(schemaFileWrites.count).toBe(0);
  });

  it('reports how each tool reaches a typed answer', () => {
    const strict = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const fallback = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

    expect(
      strict.typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'planner' })
        .typedOutput,
    ).toBe('strict-native');
    expect(
      fallback.typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'reviewer' })
        .typedOutput,
    ).toBe('fallback');
  });

  it('asks a codex release older than the proven one for the prompt fallback', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const older = createCliPlanner(config, null, {
      trustedCli: {
        ...trustedShimGate({ dir: shimDir, tool: 'codex' }),
        installedVersion: '0.40.0',
      },
    });

    expect(
      older.typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'planner' })
        .typedOutput,
    ).toBe('fallback');
  });

  it('leaves a schema-less typed call on the same opencode argv as a review', async () => {
    const { argvFile } = installRecordingShim('opencode', [
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: 'response' },
      }),
    ]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

    const typed = await planner
      .typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'reviewer' })
      .invoke({ prompt: 'q' });
    const typedArgv = readArgv(argvFile);

    await planner.review('q', projectDir, { onOutput: () => {} });
    const reviewArgv = readArgv(argvFile);

    expect(typed.status).toBe('completed');
    expect(typedArgv).toEqual(reviewArgv);
  });

  itUnix('repairs a planner answer on the codex thread that gave it', async () => {
    const countFile = join(shimDir, 'count.txt');
    const shimPath = join(shimDir, 'codex');
    const reply = (text: string) =>
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        `n=$(( $(cat '${countFile}' 2>/dev/null || echo 0) + 1 ))`,
        `echo "$n" > '${countFile}'`,
        `printf '%s\\n' "$@" > '${shimDir}/argv-'"$n"'.txt'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'codex-typed-thread' })}'`,
        'if [[ "$n" == 1 ]]; then',
        `  printf '%s\\n' '${reply('{"answer":1}')}'`,
        'else',
        `  printf '%s\\n' '${reply('{"answer":"ok","count":3}')}'`,
        'fi',
        `printf '%s\\n' '${CODEX_TURN_COMPLETED}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));

    const result = await requestTyped({
      prompt: 'q',
      schema: z.object({ answer: z.string(), count: z.number() }),
      jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      schemaName: 'probe',
      call: planner.typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'planner' }),
    });

    expect(result).toMatchObject({
      value: { answer: 'ok', count: 3 },
      nativeSessionId: 'codex-typed-thread',
    });
    const firstArgv = readArgv(join(shimDir, 'argv-1.txt'));
    const repairArgv = readArgv(join(shimDir, 'argv-2.txt'));
    expect(firstArgv).not.toContain('--ephemeral');
    expect(firstArgv).not.toContain('resume');
    expect(repairArgv).toContain('resume');
    expect(repairArgv).toContain('codex-typed-thread');
  });
});

itUnix.each(['planner', 'reviewer'] as const)(
  'forwards steering through the %s typed call',
  async (seat) => {
    installClaudeSteeringShim(shimDir);
    const port = createSteeringPort();
    const sends: Promise<SteerOutcome>[] = [];
    let started = false;
    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
      null,
      {
        trustedCli: {
          ...trustedShimGate({ dir: shimDir, tool: 'claude-code' }),
          installedVersion: '2.1.296',
        },
      },
    );
    const call = planner.typedCall({
      projectDir,
      seat,
      callbacks: {
        onOutput: () => {},
        steering: port,
        onCallEvent: (event) => {
          if (event.type === 'call_tool_use_delta' && !started) {
            started = true;
            sends.push(deliverToRunningCall(port.current(), { id: 'forwarded', text: 'steer' }));
          }
        },
      },
    });
    const result = await call.invoke({
      prompt: 'initial',
      schema: { json: { type: 'object' }, name: 'answer' },
    });
    expect(result.status).toBe('completed');
    expect(await Promise.all(sends)).toEqual(['delivered']);
    expect(port.current()).toBeNull();
  },
);
