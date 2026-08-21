import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, chmodSync, mkdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCliPlanner as createCliPlannerImpl } from './cli.js';
import { makeConfig as makeBaseConfig } from '#testing/helpers/factories/config.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { TASKS_FILE } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { PlannerFactoryOptions } from './types.js';
import type { CliStartGate } from '../runners/start-gate.js';
import type { RunnerCallEvent } from '../calls/types.js';

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

let projectDir: string;
let shimDir: string;
let restorePath: () => void;

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

function installShim(command: string, bodyLines: string[]): void {
  writeCommandShim({
    dir: shimDir,
    command,
    lines:
      command === 'codex' && !bodyLines.some((line) => line.includes('turn.completed'))
        ? [...bodyLines, CODEX_TURN_COMPLETED]
        : bodyLines,
  });
}

beforeEach(() => {
  projectDir = createTempDir('cli-artifact-ownership');
  createTestGitRepo(projectDir);
  shimDir = createTempDir('cli-artifact-ownership-shim');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  cleanupTempDir(projectDir);
  cleanupTempDir(shimDir);
});

describe('generic CLI planner artifact ownership', () => {
  it('ambient-preseed: stale files, session artifacts, links, and prose never supply phase content', async () => {
    const currentTasks = `---
id: T001
title: Current-call task
action: create
file: src/current.ts
depends_on: []
---

### Description
Produced by the current call only.
`;
    const ambientTasks = `---
id: T999
title: Ambient task
action: create
file: src/ambient.ts
depends_on: []
---

### Description
Stale ambient content.
`;
    const finalText = `Wrote [${TASKS_FILE}](${TASKS_FILE}) with one brief.\n\n${currentTasks}`;
    writeFileSync(join(projectDir, TASKS_FILE), ambientTasks);
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeFileSync(join(projectDir, 'docs', TASKS_FILE), ambientTasks);
    writeSpecFile({ projectDir, sessionId: 'workflow-session' }, TASKS_FILE, ambientTasks);

    installShim('opencode', [
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: finalText },
      }),
    ]);
    const planner = createCliPlanner(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

    const result = await planner.quickPlan({
      feature: 'current-call only',
      projectDir,
      callbacks: { onOutput: vi.fn(), sessionId: 'workflow-session' },
    });

    expect(result.tasks.map((task) => task.id)).toEqual(['T001']);
    expect(result.phases?.[0]?.artifact).toMatchObject({
      logicalName: TASKS_FILE,
      transport: 'stdout-final',
      text: finalText,
    });
    expect(result.phases?.[0]?.rawOutput).toBeUndefined();
  });

  it('detached-expiry-without-fallback: an expired resume session fails with exactly one attempt', async () => {
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
        feature: 'detached expiry',
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
});
