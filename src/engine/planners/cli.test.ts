import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, chmodSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCliPlanner } from './cli.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../lib/process/errors.js';
import { TASKS_FILE } from '../../core/paths.js';
import type { RunnerCallEvent } from '../calls/types.js';

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

function installShim(command: string, bodyLines: string[]): void {
  writeCommandShim({ dir: shimDir, command, lines: bodyLines });
}

function installRecordingShim(command: string, bodyLines: string[]): { argvFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const shimPath = join(shimDir, command);
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
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
        '  exit 0',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'sess-fresh' }).replace(/'/g, "'\\''")}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: tasksMarkdown } }).replace(/'/g, "'\\''")}'`,
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

  it('uses bounded stderr for Aider postProcess usage extraction', async () => {
    const shimPath = join(shimDir, 'aider');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        "printf '%s\\n' 'Aider response text'",
        "printf '%s\\n' 'Tokens: 1 sent, 1 received.' >&2",
        'node -e \'process.stderr.write("x".repeat(2 * 1024 * 1024) + "\\n")\' >&2',
        "printf '%s\\n' 'Tokens: 321 sent, 123 received.' >&2",
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'aider' } }));

    const result = await planner.review('prompt', projectDir, { onOutput: vi.fn() });

    expect(result.text).toContain('Aider response text');
    expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 123 });
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
    // Point PATH at an empty dir — no `codex` shim → ENOENT.
    process.env['PATH'] = createTempDir('empty-path');

    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));

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
      lines: [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'slow response' },
        }),
      ],
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
