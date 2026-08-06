import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeFileSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  existsSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createCliPlanner as createCliPlannerImpl } from './cli.js';
import { makeConfig as makeBaseConfig } from '#testing/helpers/factories/config.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../lib/process/errors.js';
import { SANDBOX_DIR, TASKS_FILE } from '../../core/paths.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { CLI_RAW_OUTPUT_MAX_BYTES } from '../runners/cli-tools/process-invoke.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { PlannerFactoryOptions } from './types.js';
import type { CliStartGate } from '../runners/start-gate.js';

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
 *
 * Same technique as `src/engine/claude-runner.test.ts`.
 */

let projectDir: string;
let shimDir: string;
let restorePath: () => void;
const itUnix = process.platform === 'win32' ? it.skip : it;

/**
 * Planner execution accepts only a canonical identity produced by readiness.
 * Test shims are real executable files; derive their path and fingerprint just
 * as the production readiness/start gate does.
 */
function trustedGate(tool: CliToolId): CliStartGate {
  const commandPath = join(shimDir, CLI_TOOL_CATALOG[tool].command);
  if (!existsSync(commandPath)) {
    writeFileSync(commandPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(commandPath, 0o755);
  }
  const path = realpathSync(commandPath);
  const info = statSync(path);
  return {
    tool,
    executable: {
      path,
      fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    },
  };
}

function createCliPlanner(
  config: Parameters<typeof createCliPlannerImpl>[0],
  initialSessionId?: string | null,
  options?: PlannerFactoryOptions,
): ReturnType<typeof createCliPlannerImpl> {
  const tool = config.planner.kind === 'cli' ? config.planner.tool : null;
  if (tool === null) throw new Error('test helper requires a CLI planner config');
  return createCliPlannerImpl(config, initialSessionId, {
    ...options,
    trustedCli: options?.trustedCli ?? trustedGate(tool),
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

  it('passes only the explicitly selected API-key channel to a normal planner process', async () => {
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

      await planner.review('prompt', projectDir, { onOutput: vi.fn() });

      expect(readFileSync(envFile, 'utf8')).toBe(
        `sk-openai||${join(projectDir, SANDBOX_DIR, 'planner', 'home')}`,
      );
    } finally {
      if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  });

  it('capabilities: supportsSessionResume mirrors the tool config (codex yes, opencode no)', () => {
    const withResume = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    expect(withResume.capabilities.supportsHintEscalation).toBe(true);
    expect(withResume.capabilities.supportsSessionResume).toBe(true);

    const noResume = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    expect(noResume.capabilities.supportsHintEscalation).toBe(true);
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

    // plan() runs multiple phases; we just need session capture on first phase.
    // Capture errors so the test does not depend on full plan success.
    try {
      await planner.plan({
        feature: 'add auth',
        projectDir,
        callbacks: { onOutput: vi.fn(), onSessionId },
      });
    } catch {
      // Shim only emits one "phase" — later phase invocations may throw. The
      // session-id capture happens on the first run regardless.
    }

    expect(onSessionId).toHaveBeenCalledWith('sess-abc');
  });

  it('suppresses expired-session resume attempt events when fallback succeeds', async () => {
    const tasksMarkdown = `---
id: T001
title: Fallback task
action: create
file: src/fallback.ts
depends_on: []
---

### Description
Create the fallback file.

### Tests
- fallback attempt succeeds
`;
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'if printf \'%s\\n\' "$@" | grep -q "^sess-old$"; then',
        "  printf '%s\\n' 'session not found: sess-old' >&2",
        '  exit 1',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: tasksMarkdown } }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const events: RunnerCallEvent[] = [];
    const planner = createCliPlanner(
      makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      'sess-old',
    );

    const result = await planner.quickPlan({
      feature: 'fallback',
      projectDir,
      callbacks: {
        onOutput: vi.fn(),
        onCallEvent: (event) => events.push(event),
      },
    });

    expect(result.tasks).toHaveLength(1);
    const started = events.filter((event) => event.type === 'call_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ attempt: 2 });
    expect(started[0]?.callId).toMatch(/-attempt-2$/);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'call_error' }));
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'call_stderr_delta',
        text: expect.stringContaining('session not found'),
      }),
    );
    expect(JSON.stringify(events)).not.toContain('sess-old');
  });

  it('treats a different returned Codex thread id as expired resume and does not persist it', async () => {
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
        'if printf \'%s\\n\' "$@" | grep -q "^sess-old$"; then',
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

    const result = await planner.quickPlan({
      feature: 'fallback',
      projectDir,
      callbacks: {
        onOutput: vi.fn(),
        onSessionId,
        onSessionExpired,
        onCallEvent: (event) => events.push(event),
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).not.toHaveBeenCalledWith('sess-new-unexpected');
    expect(onSessionId).toHaveBeenCalledWith('sess-fresh');

    const sessionEvents = events.filter((event) => event.type === 'call_session_id');
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toMatchObject({ nativeSessionId: 'sess-fresh' });
  });

  it('applies the aider postProcess hook: pulls usage from stderr when present', async () => {
    // Aider parses stdout as text-lines and uses postProcess to extract token counts from stderr.
    // The shim writes a usage line to stderr; postProcess should find it and populate result.usage.
    const shimPath = join(shimDir, 'aider');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        "printf '%s\\n' 'Aider response text'",
        "printf '%s\\n' 'Tokens: 100 sent, 50 received.' >&2",
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'aider' } }));

    const result = await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    expect(result.text).toContain('Aider response text');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('rejects a typed truncated call and reaps Aider when stdout exceeds its budget', async () => {
    const pidFile = join(shimDir, 'aider-pids.json');
    const shimPath = join(shimDir, 'aider');
    const script = [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
      "process.stdout.write('Aider response text\\n');",
      "const frame = 'x'.repeat(999_999) + '\\n';",
      `setTimeout(() => { for (let i = 0; i < ${Math.ceil(CLI_RAW_OUTPUT_MAX_BYTES / 1_000_000) + 2}; i += 1) process.stdout.write(frame); }, 25);`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'aider' } }));
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
          message: expect.stringContaining('output budget'),
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

  it('uses a CLI-written tasks.md artifact when stdout reports the file path', async () => {
    const tasksMarkdown = `---
id: T001
title: CLI-written task
action: create
file: src/cli-written.ts
depends_on: []
---

### Description
Create the CLI-written file.

### Tests
- creates the file

### Constraints
- no extra files
`;
    const artifactPath = join(projectDir, TASKS_FILE);
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `cat > '${artifactPath}' <<'EOF'`,
        tasksMarkdown,
        'EOF',
        `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Wrote [${TASKS_FILE}](${artifactPath}).` } }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));

    const result = await planner.quickPlan({
      feature: 'make it better',
      projectDir,
      callbacks: { onOutput: vi.fn() },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T001');
    expect(result.phases?.[0]?.text).toContain('CLI-written task');
    expect(result.phases?.[0]?.rawOutput).toContain(`Wrote [${TASKS_FILE}]`);
  });

  itUnix('does not read root tasks.md through a final symlink', async () => {
    const outside = createTempDir('cli-planner-outside');
    try {
      const secretTasks = `---
id: T999
title: Symlinked secret task
action: create
file: src/secret.ts
depends_on: []
---

### Description
Outside task content.
`;
      writeFileSync(join(outside, TASKS_FILE), secretTasks);
      symlinkSync(join(outside, TASKS_FILE), join(projectDir, TASKS_FILE));

      installShim('codex', [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: `Wrote [${TASKS_FILE}](${TASKS_FILE}).` },
        }),
      ]);

      const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
      const result = await planner.quickPlan({
        feature: 'make it better',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      });

      expect(result.tasks).toHaveLength(0);
      expect(result.phases?.[0]?.text).not.toContain('Symlinked secret task');
    } finally {
      cleanupTempDir(outside);
    }
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

  it('uses cfg.outputFormat to select the parser over the tool default', async () => {
    // Codex defaults to JSONL; opencode-format lines would be opaque to it.
    // Forcing outputFormat: 'text' makes the planner read raw lines verbatim.
    installShim('codex', ['plain text line']);

    const planner = createCliPlanner(
      makeConfig({
        planner: { kind: 'cli', tool: 'codex', outputFormat: 'text' },
      }),
    );

    const result = await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    expect(result.text).toContain('plain text line');
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
