import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { REVIEW_FILE, SANDBOX_DIR, sessionDir } from '../../../src/core/paths.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir, normalizeMacTmpPath } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeCallbacks, runWorkspaceDir } from '#testing/helpers/orchestrator-factories.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { resolveCustomExecutable } from '../../../src/engine/runners/resolve-cli-executable.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';

const dirs: string[] = [];
let originalPath: string | undefined;

beforeEach(() => {
  resetAllStores();
  originalPath = process.env.PATH;
});

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(marker: string): string {
  const projectDir = createTempDir('orch-int-cli-planner-implementer');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  writeFileSync(
    join(projectDir, 'validate.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const content = readFileSync('src/cli-planner-implementer.ts', 'utf-8');",
      `if (!content.includes(${JSON.stringify(marker)})) {`,
      `  console.error(${JSON.stringify(`expected ${marker} implementation`)});`,
      '  process.exit(1);',
      '}',
    ].join('\n') + '\n',
    'utf-8',
  );
  return projectDir;
}

/** The plan the fake planner answers its planning session with. */
function planAnswer(): string {
  return JSON.stringify({
    result: {
      kind: 'plan',
      summary: 'Prove a CLI planner task can be built by a separate CLI implementer.',
      decisions: [],
      criteria: [{ id: 'C1', text: 'validate.mjs passes', checkIds: ['K1'] }],
      checks: [],
      validation: null,
      tasks: [
        {
          id: 'T001',
          title: 'Create CLI planner implementer module',
          intent:
            'Create a module proving a CLI planner task can be implemented by a separate CLI implementer.',
          criteria: ['C1'],
          checks: [{ id: 'K1', kind: 'cmd', value: 'node validate.mjs', required: true }],
          suggestedFiles: ['src/cli-planner-implementer.ts'],
          contextFiles: [],
          exclusions: ['validation script changes', 'unrelated source files'],
          protectedOperations: null,
          steps: [
            'Create src/cli-planner-implementer.ts.',
            'Export the marker string expected by validate.mjs.',
          ],
          dependsOn: [],
          batch: 1,
        },
      ],
    },
  });
}

function installFakeCodexPlanner(binDir: string): string {
  const runLogPath = join(binDir, 'codex-runs.jsonl');
  const executablePath = join(binDir, 'codex');
  const script = [
    '#!/usr/bin/env node',
    "const { appendFileSync, readFileSync } = require('node:fs');",
    `const runLogPath = ${JSON.stringify(runLogPath)};`,
    `const plan = ${JSON.stringify(planAnswer())};`,
    'appendFileSync(runLogPath, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");',
    'if (process.argv.includes("--version")) {',
    '  console.log("codex 0.147.0");',
    '  process.exit(0);',
    '}',
    'const prompt = process.argv[process.argv.length - 1] === "-" ? readFileSync(0, "utf-8") : "";',
    'const threadId = process.argv[process.argv.length - 2] ?? "fake-codex-thread";',
    'if (prompt.includes("Final Implementation Review")) {',
    '  const ids = (label) => {',
    "    const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));",
    "    const value = match ? match[1].trim() : 'none';",
    "    return value === 'none' || value === '' ? [] : value.split(',').map((id) => id.trim()).filter(Boolean);",
    '  };',
    "  const verdict = { tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })), criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })), findings: [] };",
    '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } }));',
    '  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 17, output_tokens: 9 } }));',
    '  process.exit(0);',
    '}',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: plan } }));',
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 101, output_tokens: 33 } }));',
  ].join('\n');
  writeFileSync(executablePath, script + '\n', 'utf-8');
  chmodSync(executablePath, 0o755);
  return runLogPath;
}

function installFakeOpencodeImplementer(binDir: string, marker: string): string {
  const runLogPath = join(binDir, 'opencode-run.json');
  const executablePath = join(binDir, 'opencode');
  const script = [
    '#!/usr/bin/env node',
    "const { mkdirSync, writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `const marker = ${JSON.stringify(marker)};`,
    `const runLogPath = ${JSON.stringify(runLogPath)};`,
    'if (process.argv.includes("--version")) {',
    '  console.log("opencode 1.18.15");',
    '  process.exit(0);',
    '}',
    'const prompt = process.argv[process.argv.length - 1] ?? "";',
    'writeFileSync(runLogPath, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), env: { HOME: process.env.HOME ?? null, TMPDIR: process.env.TMPDIR ?? null, npm_config_cache: process.env.npm_config_cache ?? null } }));',
    'if (!prompt.includes("CLI planner implementer module")) {',
    '  console.error("missing task title in implementer prompt");',
    '  process.exit(2);',
    '}',
    "mkdirSync('src', { recursive: true });",
    "writeFileSync('src/cli-planner-implementer.ts', 'export const cliPlannerImplementer = \"' + marker + '\";\\n', 'utf-8');",
    "console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'implemented src/cli-planner-implementer.ts' } }));",
    "console.log(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 77, output: 22 } } }));",
  ].join('\n');
  writeFileSync(executablePath, script + '\n', 'utf-8');
  chmodSync(executablePath, 0o755);
  return runLogPath;
}

describe('CLI planner to CLI implementer workflow', { timeout: 90_000 }, () => {
  it('runs a Codex-style planner subprocess and a separate OpenCode-style implementer subprocess', async () => {
    const marker = 'from-cli-planner-to-cli-implementer';
    const projectDir = setupProject(marker);
    const binDir = createTempDir('fake-cli-planner-implementer-bin');
    dirs.push(binDir);
    const codexRunLogPath = installFakeCodexPlanner(binDir);
    const opencodeRunLogPath = installFakeOpencodeImplementer(binDir, marker);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    const events: EngineEvent[] = [];
    const feature = 'prove a Codex CLI planner can hand work to an OpenCode CLI implementer';
    const config = parsePreparedConfig(
      makeConfig({
        planner: {
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-5-codex-test',
        },
        implementer: {
          kind: 'cli',
          tool: 'opencode',
          model: 'opencode/test-cheap-model',
          contextLength: 4096,
        },
        validation: {
          typecheck: false,
          lint: false,
          test: true,
          testCommand: 'node validate.mjs',
        },
        workflow: {
          approve: 'none',
          maxRetries: 1,
        },
      }),
    );
    const preparationId = 'cli-planner-cli-implementer-preparation';
    const sessionId = 'sess-cli-planner-cli-implementer';
    const plannerResolution = await resolveCustomExecutable({ command: 'codex', projectDir });
    const implementerResolution = await resolveCustomExecutable({
      command: 'opencode',
      projectDir,
    });
    if (plannerResolution.kind !== 'resolved' || implementerResolution.kind !== 'resolved') {
      throw new Error('CLI fixture executables did not resolve.');
    }
    const active = {
      version: 1 as const,
      sessionId,
      generation: '1a111111-1111-4111-8111-111111111111',
    };
    const prepared: PreparedExecution = {
      purpose: 'new-workflow',
      config,
      preparationId,
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      gates: [
        {
          kind: 'cli',
          slot: { role: 'planner' },
          preparationId,
          tool: 'codex',
          executable: plannerResolution.executable,
        },
        {
          kind: 'cli',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          tool: 'opencode',
          executable: implementerResolution.executable,
        },
      ],
      session: { kind: 'existing', ref: { projectDir, sessionId }, active },
      runtime: { feature, allowRepoRunners: false, allowHooks: false },
    };

    const summary = await runWorkflow({
      prepared,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _eventSink: (event) => events.push(event),
    });

    const codexRuns = readFileSync(codexRunLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { cwd: string; args: string[] });
    expect(codexRuns.some((run) => run.args.includes('--version'))).toBe(true);
    expect(codexRuns.some((run) => run.args.includes('exec') && run.args.includes('--json'))).toBe(
      true,
    );

    const opencodeRun = JSON.parse(readFileSync(opencodeRunLogPath, 'utf-8')) as {
      cwd: string;
      args: string[];
      env: { HOME: string | null; TMPDIR: string | null; npm_config_cache: string | null };
    };
    expect(opencodeRun.cwd).not.toBe(projectDir);
    // The implementer's sandbox is rooted at its own role, not at the worktree's
    // shared sandbox: the planner running in the same worktree gets a sibling
    // root, so neither role's bridged credential state is the other's destination.
    expect(normalizeMacTmpPath(opencodeRun.env.HOME)).toBe(
      normalizeMacTmpPath(join(opencodeRun.cwd, SANDBOX_DIR, 'implementer', 'opencode', 'home')),
    );
    // Temp sits in the system temp directory, outside every worktree.
    expect(opencodeRun.env.TMPDIR).toMatch(/\/sb-[0-9a-f]{12}$/u);
    expect(
      normalizeMacTmpPath(opencodeRun.env.TMPDIR)?.startsWith(
        normalizeMacTmpPath(opencodeRun.cwd) ?? '',
      ),
    ).toBe(false);
    expect(normalizeMacTmpPath(opencodeRun.env.npm_config_cache)).toBe(
      normalizeMacTmpPath(
        join(opencodeRun.cwd, SANDBOX_DIR, 'implementer', 'opencode', 'npm-cache'),
      ),
    );
    expect(opencodeRun.args).toEqual(
      expect.arrayContaining(['--model', 'opencode/test-cheap-model']),
    );

    expect(
      readFileSync(
        join(runWorkspaceDir({ projectDir, sessionId }), 'src/cli-planner-implementer.ts'),
        'utf-8',
      ),
    ).toContain(marker);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      failed: 0,
      plannerTool: 'codex',
      plannerModel: 'gpt-5-codex-test',
      implementerTool: 'opencode',
      implementerModel: 'opencode/test-cheap-model',
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'workflow_started',
        'implementer_generate_done',
        'task_completed',
        'workflow_complete',
      ]),
    );
    expect(
      events.find((event) => event.type === 'validate' && event.status === 'done'),
    ).toMatchObject({
      type: 'validate',
      passed: true,
    });
    expect(
      readFileSync(
        join(sessionDir(projectDir, 'sess-cli-planner-cli-implementer'), REVIEW_FILE),
        'utf-8',
      ),
    ).toContain('### Verdict\n\npass');
  }, 90_000);
});
