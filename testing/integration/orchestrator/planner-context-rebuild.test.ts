import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../../src/core/schemas/config.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { recordSeatIdentities } from '../../../src/core/state/seats.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { appendMessage } from '../../../src/core/sessions/log-writer.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { applyRecoveryAction } from '../../../src/engine/orchestrator/recovery/actions.js';
import { resolveCustomExecutable } from '../../../src/engine/runners/resolve-cli-executable.js';
import { parsePreparedConfig } from '../../../src/engine/runners/prepared-execution.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

type PlannerCall = { args: string[]; prompt: string };

const FEATURE = 'name the export';
const TRANSCRIPT_LINE = 'The export must be named PERIWINKLE-42.';
const QUESTION = JSON.stringify({
  result: {
    kind: 'questions',
    questions: [{ id: 'module', text: 'Which module?', choices: null, default: 'src' }],
  },
});

/**
 * Fake planner CLIs that log every call with the prompt they read from stdin.
 * codex has lost every saved thread: `exec resume` fails the way codex-cli 0.157.1
 * does (captured live), and while `codex-fresh-fails` exists a fresh thread fails too.
 * claude resumes the thread it is handed, except `claude-session-gone`, which it
 * answers the way Claude Code 2.1.284 does (captured live). Both tools answer with a
 * clarification question, which parks the run before any brief is built.
 */
function installPlannerClis(binDir: string): {
  codexLog: string;
  claudeLog: string;
  codexFreshFails: string;
} {
  const codexLog = join(binDir, 'codex-calls.jsonl');
  const claudeLog = join(binDir, 'claude-calls.jsonl');
  const codexFreshFails = join(binDir, 'codex-fresh-fails');
  const codex = [
    '#!/usr/bin/env node',
    "const { appendFileSync, existsSync, readFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { console.log("codex-cli 0.157.1"); process.exit(0); }',
    'const prompt = args[args.length - 1] === "-" ? readFileSync(0, "utf-8") : "";',
    `appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify({ args, prompt }) + "\\n");`,
    'if (args.includes("resume")) {',
    '  const thread = args[args.length - 2];',
    '  console.error("Error: thread/resume: thread/resume failed: no rollout found for thread id " + thread + " (code -32600)");',
    '  process.exit(1);',
    '}',
    `if (existsSync(${JSON.stringify(codexFreshFails)})) {`,
    '  console.error("Error: stream disconnected before completion");',
    '  process.exit(1);',
    '}',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-fresh" }));',
    `console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(QUESTION)} } }));`,
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }));',
  ];
  const claude = [
    '#!/usr/bin/env node',
    "const { appendFileSync, readFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { console.log("2.1.280 (Claude Code)"); process.exit(0); }',
    'const prompt = args.includes("-p") ? readFileSync(0, "utf-8") : "";',
    `appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ args, prompt }) + "\\n");`,
    'const resumed = args.indexOf("--resume");',
    'const session = resumed === -1 ? "claude-session-new" : args[resumed + 1];',
    'if (session === "claude-session-gone") {',
    '  const lost = "No conversation found with session ID: " + session;',
    '  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: session, errors: [lost] }));',
    '  console.error(lost);',
    '  process.exit(1);',
    '}',
    'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));',
    `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(QUESTION)}, session_id: session, usage: { input_tokens: 3, output_tokens: 2 } }));`,
  ];
  const scripts: Record<string, string[]> = {
    codex,
    claude,
    opencode: ['#!/bin/sh', 'echo "opencode 1.18.15"'],
  };
  for (const [command, lines] of Object.entries(scripts)) {
    writeFileSync(join(binDir, command), `${lines.join('\n')}\n`, 'utf-8');
    chmodSync(join(binDir, command), 0o755);
  }
  return { codexLog, claudeLog, codexFreshFails };
}

function plannerCalls(callLog: string): PlannerCall[] {
  return readFileSync(callLog, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as PlannerCall)
    .filter((call) => call.prompt !== '');
}

function crewConfig(planner: Config['planner']): Config {
  return parsePreparedConfig(
    makeConfig({
      planner,
      implementer: { kind: 'cli', tool: 'opencode', model: 'opencode/test', contextLength: 4096 },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { approve: 'none', maxRetries: 1 },
    }),
  );
}

/** A quick run stopped in planning on this planner thread, with one user line in its transcript. */
function seedPlanningRun(ref: SessionRef, plannerSessionId: string): void {
  ensureSessionDir(ref.projectDir, ref.sessionId);
  const started = transition({ ...createInitialState(FEATURE), mode: 'quick' }, { type: 'START' });
  saveState(ref, { ...started, plannerSessionId });
  appendMessage(ref, { role: 'user', phase: 'planning', text: TRANSCRIPT_LINE });
}

async function resumeRun(ref: SessionRef, config: Config, plannerCommand: string): Promise<void> {
  const planner = await resolveCustomExecutable({
    command: plannerCommand,
    projectDir: ref.projectDir,
  });
  const implementer = await resolveCustomExecutable({
    command: 'opencode',
    projectDir: ref.projectDir,
  });
  if (planner.kind !== 'resolved' || implementer.kind !== 'resolved') {
    throw new Error('CLI fixture executables did not resolve.');
  }
  const plannerTool = config.planner.kind === 'cli' ? config.planner.tool : null;
  if (plannerTool === null) throw new Error('expected a CLI planner seat');
  const prepared = makePreparedExecution({
    ...ref,
    feature: FEATURE,
    config,
    purpose: 'resume',
    active: reactivateExistingSession(ref),
    gates: (preparationId) => [
      {
        kind: 'cli',
        slot: { role: 'planner' },
        preparationId,
        tool: plannerTool,
        executable: planner.executable,
      },
      {
        kind: 'cli',
        slot: { role: 'implementer', profile: 'default' },
        preparationId,
        tool: 'opencode',
        executable: implementer.executable,
      },
    ],
  });
  await runWorkflow({ prepared, callbacks: makeCallbacks().callbacks, sinks: TEST_WORKFLOW_SINKS });
}

function setup(): {
  ref: SessionRef;
  codexLog: string;
  claudeLog: string;
  codexFreshFails: string;
} {
  const projectDir = createTempDir('orch-int-planner-context');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const binDir = createTempDir('fake-planner-clis-bin');
  dirs.push(binDir);
  const logs = installPlannerClis(binDir);
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
  return { ref: { projectDir, sessionId: 'sess-planner-context' }, ...logs };
}

describe('planner context rebuild from the transcript', { timeout: 90_000 }, () => {
  it('re-issues the call on a lost codex thread on a fresh thread with the transcript, and never halts', async () => {
    const { ref, codexLog } = setup();
    seedPlanningRun(ref, 'codex-thread-gone');
    const config = crewConfig({ kind: 'cli', tool: 'codex', model: 'gpt-6-luna' });

    await resumeRun(ref, config, 'codex');

    const [expired, fresh, ...rest] = plannerCalls(codexLog);
    expect(rest).toEqual([]);
    expect(expired?.args).toEqual(expect.arrayContaining(['resume', 'codex-thread-gone']));
    expect(fresh?.args).not.toContain('resume');
    expect(fresh?.args).not.toContain('codex-thread-gone');
    expect(fresh?.prompt).toContain(TRANSCRIPT_LINE);
    const parked = loadState(ref);
    expect(parked?.pendingRecovery).toBeUndefined();
    expect(parked?.plannerSessionId).toBe('codex-thread-fresh');
    expect(parked?.pendingPlannerConversation?.questions.map((q) => q.id)).toEqual(['module']);
  });

  it('re-issues the call on a lost claude session on a fresh session with the transcript, and never halts', async () => {
    const { ref, claudeLog } = setup();
    seedPlanningRun(ref, 'claude-session-gone');
    const config = crewConfig({ kind: 'cli', tool: 'claude-code', model: 'opus' });
    recordSeatIdentities(ref, config);

    await resumeRun(ref, config, 'claude');

    const [expired, fresh, ...rest] = plannerCalls(claudeLog);
    expect(rest).toEqual([]);
    expect(expired?.args).toEqual(expect.arrayContaining(['--resume', 'claude-session-gone']));
    expect(fresh?.args).not.toContain('--resume');
    expect(fresh?.prompt).toContain(TRANSCRIPT_LINE);
    const parked = loadState(ref);
    expect(parked?.pendingRecovery).toBeUndefined();
    expect(parked?.plannerSessionId).toBe('claude-session-new');
    expect(parked?.pendingPlannerConversation?.questions.map((q) => q.id)).toEqual(['module']);
  });

  it('halts when the re-issued call fails too, and the retry starts fresh from the transcript', async () => {
    const { ref, codexLog, codexFreshFails } = setup();
    seedPlanningRun(ref, 'codex-thread-gone');
    const config = crewConfig({ kind: 'cli', tool: 'codex', model: 'gpt-6-luna' });
    writeFileSync(codexFreshFails, '');

    await resumeRun(ref, config, 'codex');

    const halted = loadState(ref);
    expect(halted?.pendingRecovery?.reason).toBe('planner-call-failed');
    expect(halted?.plannerSessionId).toBeNull();
    if (halted === null) throw new Error('expected the halted state to persist');
    rmSync(codexFreshFails);
    const retried = applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'retry-same-worker',
      bus: makeBusRecorder().bus,
    });
    expect(retried.ok).toBe(true);

    await resumeRun(ref, config, 'codex');

    const [expired, reissued, retry, ...rest] = plannerCalls(codexLog);
    expect(rest).toEqual([]);
    expect(expired?.args).toEqual(expect.arrayContaining(['resume', 'codex-thread-gone']));
    expect(reissued?.args).not.toContain('resume');
    expect(reissued?.prompt).toContain(TRANSCRIPT_LINE);
    expect(retry?.args).not.toContain('resume');
    expect(retry?.prompt).toContain(TRANSCRIPT_LINE);
    expect(loadState(ref)?.plannerSessionId).toBe('codex-thread-fresh');
  });

  it('hands the transcript to the PLAN seat a run moved to, never the old seat thread', async () => {
    const { ref, claudeLog } = setup();
    seedPlanningRun(ref, 'codex-thread-1');
    recordSeatIdentities(ref, crewConfig({ kind: 'cli', tool: 'codex', model: 'gpt-6-astra' }));

    await resumeRun(ref, crewConfig({ kind: 'cli', tool: 'claude-code', model: 'opus' }), 'claude');

    const [first, ...rest] = plannerCalls(claudeLog);
    expect(rest).toEqual([]);
    expect(first?.args).not.toContain('--resume');
    expect(first?.args).not.toContain('codex-thread-1');
    expect(first?.prompt).toContain(TRANSCRIPT_LINE);
    expect(loadState(ref)?.plannerSessionId).toBe('claude-session-new');
  });

  it('resumes the saved thread of a PLAN seat that stayed, and hands it no transcript', async () => {
    const { ref, claudeLog } = setup();
    seedPlanningRun(ref, 'claude-session-1');
    const config = crewConfig({ kind: 'cli', tool: 'claude-code', model: 'opus' });
    recordSeatIdentities(ref, config);

    await resumeRun(ref, config, 'claude');

    const [first, ...rest] = plannerCalls(claudeLog);
    expect(rest).toEqual([]);
    expect(first?.args).toEqual(expect.arrayContaining(['--resume', 'claude-session-1']));
    expect(first?.prompt).not.toContain(TRANSCRIPT_LINE);
  });
});
