import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Attachment } from '../../../src/core/schemas/attachment.js';
import type { Task } from '../../../src/core/schemas/task.js';
import type { UserMessageInput } from '../../../src/core/types/user-input.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';
import type { TypedCallContext } from '../../../src/engine/planners/types.js';
import type { PreparationPolicy } from '../../../src/engine/runners/prepare-execution/types.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { applyOfferedSeatSwap } from '../../../src/engine/orchestrator/run/seat-swap.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { writeConfigYamlText } from '#testing/helpers/config-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';
import {
  guidanceConsult,
  planFromTasks,
  typedCallPlanAndConsult,
} from '#testing/helpers/typed-planner.js';

const TARGET = 'src/loop.ts';
const FIRST_ATTEMPT = 'export const loop = "from-initial";\n';
const GUIDED_FIX = 'export const loop = "from-retry";\n';
const GUIDANCE = 'Use the from-retry marker from validate.mjs.';
// The failed result frame of an agy consult that ran out of quota, as the run recorded it.
const AGY_QUOTA_STOP = {
  code: 'antigravity-result-failed',
  message:
    'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 144h5m54s.',
};
const FALLBACK = { tool: 'claude-code', model: 'claude-opus-5-5' } as const;
const RESUME_POLICY: Extract<PreparationPolicy, { purpose: 'resume' }> = {
  purpose: 'resume',
  interaction: 'headless',
  allowRepoRunners: false,
  allowHooks: false,
  unverifiedAuth: 'denied',
};
const USAGE = { inputTokens: 10, outputTokens: 5 };
const STEER_WORDS = 'Keep the loop in src/loop.ts and add no index file.';
const SHOT: Attachment = {
  id: 'img-loop',
  kind: 'image',
  path: '/screens/loop.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
};
const BLOCKED_ERROR =
  'The implementer stopped before it wrote a file.\nIt needs to know which module exports loop.';
const BLOCKED = {
  status: 'blocked',
  question: 'Which module should export loop?\nThe brief names src/loop.ts and src/index.ts.',
  filesNeeded: ['src/index.ts'],
} as const;
const GUESS = 'export const loop = "from-guess";\n';
// A check whose failure prints three lines, the found source among them.
const MULTI_LINE_CHECK = `${[
  "import { readFileSync } from 'node:fs';",
  "const content = readFileSync('src/loop.ts', 'utf-8');",
  "if (!content.includes('from-retry')) {",
  "  console.error('src/loop.ts: expected from-retry implementation');",
  "  console.error('found: ' + content.trim());",
  "  console.error('hint: export the from-retry marker');",
  '  process.exit(1);',
  '}',
].join('\n')}\n`;

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(async () => {
  await settleTrackedWorkflows();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

const task: Task = makeTask({
  id: 'T001',
  action: 'create',
  suggestedFiles: [TARGET],
  title: 'Create the loop module',
  description: 'Create a module that satisfies the project validation script.',
  implementationSteps: ['Create src/loop.ts with the retry marker export.'],
  tests: ['node validate.mjs passes'],
  checks: [{ id: 'K-retry', kind: 'test', value: TARGET }],
  scope: { inBounds: [TARGET], outOfBounds: ['unrelated files'] },
  evidence: ['the consult on the fallback seat guides the fix'],
  typeDefs: 'export const loop: string',
});

type ConsultTurn = 'quota' | 'guidance';

/**
 * A PLAN seat that plans the one brief and reviews it as passing. Its consults take `turns` in
 * order and repeat the last one: a consult stops on the agy quota or answers with guidance. Each
 * consult is logged with its prompt.
 */
function planSeat(turns: readonly ConsultTurn[], calls: string[], consultPrompts: string[]) {
  const typedCall = typedCallPlanAndConsult(
    () => planFromTasks([task]),
    () => guidanceConsult(GUIDANCE),
  );
  let consults = 0;
  return makePlanner({
    typedCall: vi.fn((ctx: TypedCallContext) => {
      const call = typedCall(ctx);
      return {
        ...call,
        invoke: async (input: Parameters<typeof call.invoke>[0]) => {
          if (!/^# Consult/m.test(input.prompt)) return call.invoke(input);
          const turn = turns[Math.min(consults, turns.length - 1)];
          consults += 1;
          calls.push(`consult:${turn}`);
          consultPrompts.push(input.prompt);
          return turn === 'quota'
            ? makeRunnerCallResult({ status: 'failed', text: '', error: AGY_QUOTA_STOP })
            : call.invoke(input);
        },
      };
    }),
    review: vi.fn().mockResolvedValue({
      text: '# Final review\n\nThe guided fix passes.\n\n### Verdict\npass',
      usage: USAGE,
    }),
  });
}

/** A consult-guided BUILD call that logs the file it found and writes the guided fix. */
function guidedRetry(calls: string[]) {
  return vi.fn().mockImplementation(async (opts: RetryOptions) => {
    const file = join(opts.projectDir, TARGET);
    calls.push(`retry:${existsSync(file) ? readFileSync(file, 'utf-8') : 'no file'}`);
    expect(opts.error).toContain(GUIDANCE);
    mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
    writeFileSync(file, GUIDED_FIX, 'utf-8');
    return { success: true, output: 'fixed after the consult', usage: USAGE };
  });
}

/** A BUILD call that writes `source` to the brief's file and reports done. */
function writes(calls: string[], source: string) {
  return vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
    calls.push('implement');
    mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
    writeFileSync(join(opts.projectDir, TARGET), source, 'utf-8');
    return { success: true, output: 'created the module', usage: USAGE };
  });
}

/**
 * Runs the brief until a consult stops on the agy quota, applies the automatic switch to the
 * fallback, then continues the run from the state saved on disk, as a restart does, with the PLAN
 * seat answering every consult with guidance.
 */
async function haltOnConsultThenContinue(
  scenario: Readonly<{
    name: string;
    implementer: ReturnType<typeof makeImplementer>;
    firstConsults: readonly ConsultTurn[];
    calls: string[];
    consultPrompts: string[];
    check?: string | undefined;
    steer?: UserMessageInput | undefined;
  }>,
) {
  const projectDir = createTempDir(scenario.name);
  dirs.push(projectDir);
  createTestGitRepo(projectDir, { '.gitignore': '.splitbrief/\n' });
  seedValidationProject(projectDir);
  if (scenario.check !== undefined) writeFileSync(join(projectDir, 'validate.mjs'), scenario.check);
  const sessionId = `sess-${scenario.name}`;
  const config = makeConfig({
    planner: {
      kind: 'cli',
      tool: 'antigravity',
      model: 'gemini-3.1-pro-high',
      fallback: FALLBACK,
    },
    implementer: {
      kind: 'agent',
      command: 'node',
      model: 'cheap-direct-agent',
      contextLength: 4096,
    },
    validation: { endChecks: true, testCommand: 'node validate.mjs' },
    workflow: { approve: 'none', review: 'task' },
  });
  writeConfigYamlText(projectDir, YAML.stringify(config));
  await rememberDetectedTools(projectDir, [cliDetectionFor('ready', 'claude-code')]);
  const prepared = makePreparedExecution({
    projectDir,
    sessionId,
    feature: 'consult on the fallback seat',
    config,
  });

  await runTrackedWorkflow({
    prepared,
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_WORKFLOW_SINKS,
    _planner: planSeat(scenario.firstConsults, scenario.calls, scenario.consultPrompts),
    _implementer: scenario.implementer,
  });

  const halted = loadState({ projectDir, sessionId });
  if (halted === null) throw new Error('the halt saved no state');
  expect(halted.pendingRecovery).toMatchObject({
    reason: 'runner-usage-limit',
    seat: 'plan',
    taskId: 'T001',
  });
  const auto = halted.pendingRecovery?.switchSeat?.auto;
  expect(auto?.candidate).toMatchObject(FALLBACK);
  if (auto === undefined) throw new Error('the halt carried no automatic switch');

  const { bus, events: switchEvents } = makeBusRecorder();
  const swapped = await applyOfferedSeatSwap({
    choice: { candidate: auto.candidate, policy: RESUME_POLICY },
    projectDir,
    sessionId,
    bus,
    config,
    prepared,
    savedState: halted,
    prepare: async (request) => ({
      kind: 'prepared',
      execution: makePreparedExecution({
        projectDir,
        sessionId,
        feature: request.feature,
        config: request.effectiveConfig,
        ...(request.resumeState !== undefined && { resumeState: request.resumeState }),
      }),
    }),
  });
  if (swapped === undefined) throw new Error('the automatic seat switch was not applied');
  expect(switchEvents).toContainEqual(
    expect.objectContaining({ type: 'seat_switched', seat: 'plan', auto: true }),
  );
  const saved = loadState({ projectDir, sessionId });
  if (saved === null) throw new Error('the switch saved no state');

  const resumed: EngineEvent[] = [];
  const summary = await runTrackedWorkflow({
    prepared: swapped.prepared,
    savedState: saved,
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_WORKFLOW_SINKS,
    _planner: planSeat(['guidance'], scenario.calls, scenario.consultPrompts),
    _implementer: scenario.implementer,
    _eventSink: (event) => resumed.push(event),
    ...(scenario.steer !== undefined && { steer: scenario.steer }),
  });
  return { projectDir, sessionId, halted, swapped, summary, resumed };
}

const reasonOf = (prompt: string | undefined) => prompt?.match(/^## Reason\n(\S+) —/m)?.[1];
const failingOutputOf = (prompt: string | undefined) =>
  prompt?.match(/^## Failing Output\n[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0];

describe('a consult that stops on a usage limit', { timeout: 90_000 }, () => {
  it('runs the consult on the fallback seat before any BUILD call, on the files the first attempt left', async () => {
    const calls: string[] = [];
    const consultPrompts: string[] = [];
    const { swapped, summary, resumed } = await haltOnConsultThenContinue({
      name: 'consult-seat-down-files',
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: writes(calls, FIRST_ATTEMPT),
        retry: guidedRetry(calls),
      }),
      firstConsults: ['quota'],
      calls,
      consultPrompts,
    });

    expect(calls).toEqual([
      'implement',
      'consult:quota',
      'consult:guidance',
      `retry:${FIRST_ATTEMPT}`,
    ]);
    const fallbackConsult = consultPrompts[1] ?? '';
    expect(fallbackConsult).toContain('## Task Diff');
    expect(fallbackConsult).toContain('+export const loop = "from-initial";');
    expect(fallbackConsult).toContain(
      '- Attempt 1 (T001 revision 1): check K-retry did not pass (fail)',
    );
    expect(fallbackConsult).not.toMatch(/^- Attempt 2 /m);
    expect(summary).toMatchObject({ totalTasks: 1, failed: 0 });
    expect(resumed.map((event) => event.type)).toContain('workflow_complete');
    const workspace = swapped.state.workspace;
    if (workspace === undefined) throw new Error('the switched state recorded no workspace');
    expect(readFileSync(join(workspace.path, TARGET), 'utf-8')).toBe(GUIDED_FIX);
  });

  it('gives the fallback consult the words typed to continue, recorded once with their image', async () => {
    const calls: string[] = [];
    const consultPrompts: string[] = [];
    const { projectDir, sessionId, summary } = await haltOnConsultThenContinue({
      name: 'consult-seat-down-steer',
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: writes(calls, FIRST_ATTEMPT),
        retry: guidedRetry(calls),
      }),
      firstConsults: ['quota'],
      calls,
      consultPrompts,
      steer: { text: STEER_WORDS, displayText: STEER_WORDS, images: [SHOT], attachedInputs: [] },
    });

    expect(calls).toEqual([
      'implement',
      'consult:quota',
      'consult:guidance',
      `retry:${FIRST_ATTEMPT}`,
    ]);
    const fallbackConsult = consultPrompts[1] ?? '';
    expect(fallbackConsult).toContain('## Operator Instructions');
    expect(fallbackConsult.split(STEER_WORDS)).toHaveLength(2);
    expect(summary).toMatchObject({ totalTasks: 1, failed: 0 });
    const lineage = loadState({ projectDir, sessionId })?.lineages?.T001;
    expect(lineage?.corrections).toEqual([
      `${STEER_WORDS}\n\nAttached image paths:\n[image:${SHOT.id}] = ${SHOT.path}`,
    ]);
    expect(lineage?.correctionImages).toEqual([SHOT]);
  });

  it('asks the fallback consult the blocked question of the first consult, read back from the saved park', async () => {
    const calls: string[] = [];
    const consultPrompts: string[] = [];
    const { halted, summary } = await haltOnConsultThenContinue({
      name: 'consult-seat-down-blocked',
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: vi.fn().mockImplementation(async () => {
          calls.push('implement');
          return {
            success: false,
            output: '',
            error: BLOCKED_ERROR,
            blocked: { question: BLOCKED.question, filesNeeded: BLOCKED.filesNeeded },
            usage: USAGE,
          };
        }),
        retry: guidedRetry(calls),
      }),
      firstConsults: ['quota'],
      calls,
      consultPrompts,
    });

    expect(halted.interruptedStep?.consult).toEqual({
      failingOutput: BLOCKED_ERROR,
      report: BLOCKED,
      unfinishedCalls: 0,
    });
    expect(calls).toEqual(['implement', 'consult:quota', 'consult:guidance', 'retry:no file']);
    const [first, rerun] = consultPrompts;
    expect([reasonOf(first), reasonOf(rerun)]).toEqual(['blocked', 'blocked']);
    expect(rerun).toContain(
      `Blocked: ${BLOCKED.question}\nFiles needed: ${BLOCKED.filesNeeded.join(', ')}`,
    );
    expect(failingOutputOf(rerun)).toContain(BLOCKED_ERROR);
    expect(failingOutputOf(rerun)).toBe(failingOutputOf(first));
    expect(summary).toMatchObject({ totalTasks: 1, failed: 0 });
  });

  it('asks the fallback consult the whole check output of the consult that stopped, at its second rung', async () => {
    const calls: string[] = [];
    const consultPrompts: string[] = [];
    const retry = guidedRetry(calls);
    retry.mockImplementationOnce(async (opts: RetryOptions) => {
      calls.push('retry:guess');
      writeFileSync(join(opts.projectDir, TARGET), GUESS, 'utf-8');
      return { success: true, output: 'guessed after the consult', usage: USAGE };
    });
    const { summary } = await haltOnConsultThenContinue({
      name: 'consult-seat-down-rung',
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: writes(calls, FIRST_ATTEMPT),
        retry,
      }),
      firstConsults: ['guidance', 'quota'],
      calls,
      consultPrompts,
      check: MULTI_LINE_CHECK,
    });

    expect(calls).toEqual([
      'implement',
      'consult:guidance',
      'retry:guess',
      'consult:quota',
      'consult:guidance',
      `retry:${GUESS}`,
    ]);
    const [firstRung, stopped, rerun] = consultPrompts;
    expect(failingOutputOf(stopped)).toContain(`found: ${GUESS.trim()}`);
    expect(failingOutputOf(stopped)).toContain('hint: export the from-retry marker');
    expect(failingOutputOf(stopped)).not.toBe(failingOutputOf(firstRung));
    expect(failingOutputOf(rerun)).toBe(failingOutputOf(stopped));
    expect([reasonOf(stopped), reasonOf(rerun)]).toEqual(['failed', 'failed']);
    expect(summary).toMatchObject({ totalTasks: 1, failed: 0 });
  });

  it('counts a first call that timed out as one unfinished call on the fallback consult', async () => {
    const calls: string[] = [];
    const consultPrompts: string[] = [];
    const timedOut = {
      success: false,
      output: '',
      error: 'implementer timed out',
      outcome: 'timeout',
    };
    const { projectDir, sessionId } = await haltOnConsultThenContinue({
      name: 'consult-seat-down-timeout',
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: vi.fn().mockImplementation(async () => {
          calls.push('implement');
          return timedOut;
        }),
        retry: vi.fn().mockImplementation(async () => {
          calls.push('retry');
          return timedOut;
        }),
      }),
      firstConsults: ['quota'],
      calls,
      consultPrompts,
    });

    expect(calls).toEqual(['implement', 'consult:quota', 'consult:guidance', 'retry']);
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'runner-timeout-repeated',
      taskId: 'T001',
    });
  });
});
