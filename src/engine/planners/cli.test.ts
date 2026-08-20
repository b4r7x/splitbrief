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
import { dirname, join } from 'node:path';
import { createCliPlanner as createCliPlannerImpl } from './cli.js';
import { makeConfig as makeBaseConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../lib/process/errors.js';
import { SANDBOX_DIR, TASKS_FILE } from '../../core/paths.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { CLI_RAW_OUTPUT_MAX_BYTES } from '../runners/cli-tools/process-invoke.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { PlannerFactoryOptions, PlanResult } from './types.js';
import type { CliStartGate } from '../runners/start-gate.js';
import { writeSpecFile } from '../../core/paths-io.js';

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
        `sk-openai||${join(projectDir, SANDBOX_DIR, 'planner', 'codex', 'home')}`,
      );
    } finally {
      if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  });

  it('forwards split known-CLI question markers once while preserving output', async () => {
    const marker = '<!-- Q:{"id":"scope","type":"input","text":"Which scope?"} -->';
    const splitAt = marker.indexOf('scope');
    const chunks = [marker.slice(0, splitAt), marker.slice(splitAt), marker];
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
    const onQuestion = vi.fn();

    await planner.quickPlan({
      feature: 'prompt',
      projectDir,
      callbacks: { onOutput, onQuestion },
    });

    expect(onOutput.mock.calls.flat()).toEqual(chunks);
    expect(onQuestion).toHaveBeenCalledTimes(1);
    expect(onQuestion).toHaveBeenCalledWith([{ id: 'scope', type: 'input', text: 'Which scope?' }]);
  });

  it('deduplicates repeated known-CLI question markers in one text event', async () => {
    const marker = '<!-- Q:{"id":"scope","type":"input","text":"Which scope?"} -->';
    const combined = `${marker}${marker}`;
    installShim('opencode', [
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: combined },
      }),
    ]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const onOutput = vi.fn();
    const onQuestion = vi.fn();

    await planner.quickPlan({
      feature: 'prompt',
      projectDir,
      callbacks: { onOutput, onQuestion },
    });

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(combined);
    expect(onQuestion).toHaveBeenCalledTimes(1);
    expect(onQuestion).toHaveBeenCalledWith([{ id: 'scope', type: 'input', text: 'Which scope?' }]);
  });

  it('does not infer questions from plain known-CLI prose', async () => {
    const prose = 'Which scope should tasks.md cover?';
    installShim('opencode', [
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: prose },
      }),
    ]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const onOutput = vi.fn();
    const onQuestion = vi.fn();

    await planner.quickPlan({
      feature: 'prompt',
      projectDir,
      callbacks: { onOutput, onQuestion },
    });

    expect(onOutput).toHaveBeenCalledWith(prose);
    expect(onQuestion).not.toHaveBeenCalled();
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
      planner.quickPlan({
        feature: 'fallback',
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
      planner.quickPlan({
        feature: 'fallback',
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

    await planner.review('review the escalation', projectDir, { onOutput: () => {} });

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
      tool: 'aider',
      command: 'aider',
      output: 'Wrote src/hello.ts.',
      requiredArgs: ['--yes-always', '--no-auto-commits', '--no-dirty-commits'],
      forbiddenArgs: ['--chat-mode', 'ask'],
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

  it('keeps a successful OpenCode hint read-only and accepts its text response', async () => {
    const output = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: 'Check the failing assertion before changing the parser.' },
    });
    const { argvFile } = installRecordingShim('opencode', [output]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

    const result = await planner.escalateHint({
      task: makeTask(),
      error: 'the parser assertion failed',
      projectDir,
      callbacks: { onOutput: vi.fn() },
    });

    expect(result).toMatchObject({
      success: true,
      output: 'Check the failing assertion before changing the parser.',
      code: null,
    });
    expect(readArgv(argvFile)).toEqual(
      expect.arrayContaining(['run', '--format', 'json', '--agent', 'plan']),
    );
  });

  it.each(['hint', 'review', 'regenerate', 'summarize', 'summarizeStructured'] as const)(
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
        case 'hint':
          invocation = planner.escalateHint({
            task: makeTask(),
            error: 'the implementation failed',
            projectDir,
            callbacks: { onOutput: vi.fn() },
          });
          break;
        case 'review':
          invocation = planner.review('review the change', projectDir, { onOutput: vi.fn() });
          break;
        case 'regenerate':
          invocation = planner.regenerate({
            prompt: 'regenerate the plan',
            projectDir,
            callbacks: { onOutput: vi.fn() },
          });
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

  it.each(['normal', 'quick', 'instant'] as const)(
    'returns %s planning output for session persistence without project mutation',
    async (operation) => {
      const tasksMarkdown = `---
id: T001
title: Session-output task
action: create
file: src/session-output.ts
depends_on: []
---

### Description
Create the session-output file.

### Tests
- verifies the returned task
`;
      const output = JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: tasksMarkdown },
      });
      const { argvFile } = installRecordingShim('opencode', [output]);
      const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
      const callbacks = { onOutput: () => {}, sessionId: 'workflow-session' };

      let result: PlanResult;
      switch (operation) {
        case 'normal':
          result = await planner.plan({ feature: 'plan a change', projectDir, callbacks });
          break;
        case 'quick':
          result = await planner.quickPlan({ feature: 'plan a change', projectDir, callbacks });
          break;
        case 'instant':
          if (planner.instantPlan === undefined) {
            throw new Error('CLI planner must support instant planning');
          }
          result = await planner.instantPlan({ feature: 'plan a change', projectDir, callbacks });
          break;
      }

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.id).toBe('T001');
      expect(result.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifact: expect.objectContaining({ logicalName: TASKS_FILE, text: tasksMarkdown }),
          }),
        ]),
      );
      expect(existsSync(join(projectDir, TASKS_FILE))).toBe(false);
      const promptArg = readArgv(argvFile).find((arg) =>
        arg.includes('Return the complete tasks.md'),
      );
      expect(promptArg).toContain('Do not write tasks.md or any other project file yourself');
      expect(promptArg).not.toContain('project root');
    },
  );

  it.each(['normal', 'quick', 'instant'] as const)(
    'keeps %s planning read-only and rejects source mutations',
    async (operation) => {
      const output = JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: 'Planning response.' },
      });
      const { argvFile } = installDirectWriteRecordingShim('opencode', [output]);
      const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
      const callbacks = { onOutput: () => {}, sessionId: 'workflow-session' };

      let invocation: Promise<unknown>;
      switch (operation) {
        case 'normal':
          invocation = planner.plan({ feature: 'plan a change', projectDir, callbacks });
          break;
        case 'quick':
          invocation = planner.quickPlan({ feature: 'plan a change', projectDir, callbacks });
          break;
        case 'instant':
          if (planner.instantPlan === undefined) {
            throw new Error('CLI planner must support instant planning');
          }
          invocation = planner.instantPlan({ feature: 'plan a change', projectDir, callbacks });
          break;
      }

      await expect(invocation).rejects.toMatchObject({
        kind: 'planning-unexpected-mutations',
        data: { files: ['src/hello.ts'] },
      });
      expect(readArgv(argvFile)).toEqual(
        expect.arrayContaining(['run', '--format', 'json', '--agent', 'plan']),
      );
    },
  );

  it('completes planning when OpenCode regenerates its own .opencode plugin state', async () => {
    const tasksMarkdown = `---
id: T001
title: Internal-state task
action: create
file: src/internal-state.ts
depends_on: []
---

### Description
Create the internal-state file.

### Tests
- verifies the returned task
`;
    const output = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: tasksMarkdown },
    });
    installDirectWriteRecordingShim('opencode', [output], '.opencode/package-lock.json');
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const callbacks = { onOutput: () => {}, sessionId: 'workflow-session' };

    const result = await planner.plan({ feature: 'plan a change', projectDir, callbacks });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T001');
  });

  it('rejects OpenCode writes to user-authored .opencode config despite the internal-state exemption', async () => {
    const output = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: 'Planning response.' },
    });
    installDirectWriteRecordingShim('opencode', [output], '.opencode/plugin/injected.js');
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));
    const callbacks = { onOutput: () => {}, sessionId: 'workflow-session' };

    await expect(
      planner.plan({ feature: 'plan a change', projectDir, callbacks }),
    ).rejects.toMatchObject({
      kind: 'planning-unexpected-mutations',
      data: { files: ['.opencode/plugin/injected.js'] },
    });
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

  it('ignores a CLI-written tasks.md even when stdout reports the file path', async () => {
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

    expect(result.tasks).toHaveLength(0);
    expect(result.phases?.[0]?.artifact.text).toContain(`Wrote [${TASKS_FILE}]`);
    expect(result.phases?.[0]?.rawOutput).toBeUndefined();
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
      planner.quickPlan({
        feature: 'add a titleCase function',
        projectDir,
        callbacks: {
          onOutput: vi.fn(),
          sessionId: '2026-08-06-add-a-titlecase-function',
        },
      }),
    ).rejects.toMatchObject({
      kind: 'planning-unexpected-mutations',
      data: { files: [TASKS_FILE] },
    });
  });

  it('does not recover a tasks.md written to a subdirectory path named in backticks', async () => {
    const tasksMarkdown = `---
id: T001
title: Subdirectory task
action: create
file: src/subdir.ts
depends_on: []
---

### Description
Create the subdirectory file.

### Tests
- recovers from a named relative path
`;
    const shimPath = join(shimDir, 'codex');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'mkdir -p "$PWD/docs"',
        `cat > "$PWD/docs/${TASKS_FILE}" <<'TASKS_EOF'`,
        tasksMarkdown,
        'TASKS_EOF',
        `printf '%s\\n' '${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Created `docs/tasks.md` with one brief.' },
        }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${CODEX_TURN_COMPLETED.replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));

    const result = await planner.quickPlan({
      feature: 'subdirectory recovery',
      projectDir,
      callbacks: { onOutput: vi.fn() },
    });

    expect(result.tasks).toHaveLength(0);
    expect(result.phases?.[0]?.artifact.text).toBe('Created `docs/tasks.md` with one brief.');
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
      expect(result.phases?.[0]?.artifact.text).not.toContain('Symlinked secret task');
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

describe('CLI phase reads are terminal-only', () => {
  it('ignores pre-seeded session artifacts and uses the terminal result text', async () => {
    const sessionId = 'terminal-only-session';
    const sessionTasks = `---
id: T001
title: Session task
action: create
file: src/session.ts
depends_on: []
---

### Description
Session artifact must be ignored.
`;
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, sessionTasks);

    const stdoutText = 'Created `docs/tasks.md` with one brief.';
    installShim('opencode', [
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: stdoutText },
      }),
    ]);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

    const result = await planner.quickPlan({
      feature: 'plan a change',
      projectDir,
      callbacks: { onOutput: vi.fn(), sessionId },
    });

    expect(result.phases?.[0]?.artifact.text).toBe(stdoutText);
    expect(result.phases?.[0]?.artifact.text).not.toContain('Session artifact must be ignored');
  });
});
