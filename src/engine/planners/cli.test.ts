import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createCliPlanner } from './cli.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../lib/process/errors.js';
import { TASKS_FILE } from '../../core/paths.js';

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
let originalPath: string | undefined;

function installShim(command: string, bodyLines: string[]): void {
  const shimPath = join(shimDir, command);
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
}

beforeEach(() => {
  projectDir = createTempDir('cli-planner-project');
  createTestGitRepo(projectDir);
  shimDir = createTempDir('cli-planner-shim');
  originalPath = process.env['PATH'];
  process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
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
});
