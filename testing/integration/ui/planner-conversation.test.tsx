import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushEffects, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { mountWorkflowScreen } from '#testing/helpers/workflow-screen.js';
import type { PlannerConversation } from '../../../src/core/schemas/workflow.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { questionPromptStore } from '../../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { createTestSinks } from '#testing/helpers/planning-phase.js';
import { createClaudeCodePlanner } from '../../../src/engine/planners/claude-code.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { createJsonlSink } from '../../../src/engine/events/sinks/jsonl.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { eventRowBlock } from '../../../src/features/workflow/conversation-rows/event-rows/dispatch.js';
import { runPlanningSession } from '../../../src/engine/orchestrator/planning/session.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';

let projectDir = '';
let ui: ReturnType<typeof mountWorkflowScreen> | undefined;
let restorePath: (() => void) | undefined;

/** The header's run clock keeps counting while the planner waits; nothing else on screen moves. */
function withoutRunClock(frame: string): string {
  const [header = '', ...body] = frame.split('\n');
  return [header.replace(/\d+(?::\d{2}){1,2}$/, '<run clock>'), ...body].join('\n');
}

/** The run clock reading in the header, when the header carries one. */
function runClockOf(frame: string): string | null {
  return frame.split('\n')[0]?.match(/\d+(?::\d{2}){1,2}$/)?.[0] ?? null;
}

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  projectDir = createTempDir('planner-conversation-screen');
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  restorePath?.();
  restorePath = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(projectDir);
});

describe('planner conversation in the full workflow screen', () => {
  it('answers the planning session in the question box and replays the answer as a qa batch', async () => {
    const invocations = join(projectDir, 'invocations.json');
    const shim = join(projectDir, 'claude');
    const answers = [
      {
        kind: 'questions',
        questions: [
          {
            id: 'module',
            text: 'Which module should change?',
            choices: null,
            default: 'src/auth.ts',
          },
        ],
      },
      makePlanProposal(),
    ];
    writeFileSync(
      shim,
      `#!${process.execPath}
const fs = require('node:fs');
const path = ${JSON.stringify(invocations)};
const calls = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : [];
calls.push({args: process.argv.slice(2), prompt: fs.readFileSync(0, 'utf8')});
fs.writeFileSync(path, JSON.stringify(calls));
const answers = ${JSON.stringify(answers)};
const emit = (frame) => console.log(JSON.stringify({session_id: 'native-screen', ...frame}));
emit({type: 'system', subtype: 'init'});
emit({type: 'result', is_error: false, result: '', structured_output: {result: answers[calls.length - 1]}});
`,
    );
    chmodSync(shim, 0o755);
    restorePath = prependPath(projectDir);
    const planner = createClaudeCodePlanner({
      authChannel: undefined,
      trustedCli: trustedShimGate({ dir: projectDir, tool: 'claude-code' }),
    });
    const finished = Promise.withResolvers<void>();
    let sessionId = '';
    const runWorkflow = async (options: RunWorkflowOptions): Promise<Summary> => {
      const ref = options.prepared.session.ref;
      sessionId = ref.sessionId;
      const bus = createEventBus();
      if (options.tuiSink) bus.subscribe(options.tuiSink);
      bus.subscribe(createJsonlSink(ref));
      const state = createInitialState('Refactor the implementation');
      try {
        const result = await runPlanningSession({
          wctx: {
            ...ref,
            config: options.prepared.config,
            bus,
            callbacks: options.callbacks,
            sinks: createTestSinks(),
            metadata: { planner: 'Claude Code CLI · auto', implementer: 'test · auto' },
            signal: options.signal,
          },
          state,
          planner,
          feature: state.feature,
        });
        expect(result.disposition).toBe('tasks-ready');
        return makeSummary();
      } finally {
        finished.resolve();
      }
    };
    ui = mountWorkflowScreen({ deps: { runWorkflow }, projectDir, rows: 40 });
    const screen = ui;
    try {
      await vi.waitFor(
        () => expect(stripAnsiStyles(screen.lastFrame())).toContain('Question 1 of 1'),
        { timeout: 3000 },
      );
      await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      // The draft starts filled with the default; the answer extends it.
      screen.stdin.write('; preserve the public API.');
      await flushEffects();
      screen.stdin.write('\r');
      await vi.waitFor(
        () => {
          const frame = stripAnsiStyles(screen.lastFrame());
          expect(frame).toContain('Answered · 1 question');
          expect(frame).toContain('1. Which module should change?');
          expect(frame).toContain('src/auth.ts; preserve the public API.');
        },
        { timeout: 3000 },
      );
      const userMessages = eventsStore
        .get()
        .events.filter((event) => event.type === 'user_message');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({
        text: '1. Which module should change?\nsrc/auth.ts; preserve the public API.',
        qa: [
          {
            question: 'Which module should change?',
            answer: 'src/auth.ts; preserve the public API.',
          },
        ],
      });
    } catch (cause) {
      screen.unmount();
      throw cause;
    } finally {
      await finished.promise;
    }
    const calls: unknown = JSON.parse(readFileSync(invocations, 'utf8'));
    expect(calls).toEqual([
      expect.anything(),
      expect.objectContaining({
        args: expect.arrayContaining(['--resume', 'native-screen']),
        prompt: expect.stringContaining('src/auth.ts; preserve the public API.'),
      }),
    ]);
    const replay = await readRunEvents({ projectDir, sessionId });
    expect(
      replay.events
        .filter((event) => event.type === 'artifact_written')
        .map((event) => event.filename),
    ).toEqual(['plan.md', 'tasks.md']);
    const replayedUserMessage = replay.events.find((event) => event.type === 'user_message');
    if (replayedUserMessage?.type !== 'user_message') throw new Error('no replayed user message');
    const block = eventRowBlock({
      event: replayedUserMessage,
      globalIndex: 0,
      ctx: { width: 80, viewportRows: 20, streaming: { taskId: null, lines: [], active: false } },
      expanded: false,
    });
    const rows = block?.createRows(0, block.rowCount) ?? [];
    expect(rows.map((row) => row.kind)[0]).toBe('prompt');
    expect(rows.map((row) => row.segments.map((segment) => segment.text).join(''))).toEqual([
      'Answered · 1 question',
      '1. Which module should change?',
      'You → src/auth.ts; preserve the public API.',
    ]);
  });

  it.each(['ordinary', 'structured'] as const)(
    'shows the %s reply and sends one composer answer to the waiting turn',
    async (kind) => {
      const received = vi.fn();
      const reply: PlannerConversation = {
        call: 'research',
        text: kind === 'ordinary' ? 'Which module should change?' : '',
        questions:
          kind === 'ordinary'
            ? []
            : [
                { id: 'module', type: 'input', text: 'Which module should change?' },
                {
                  id: 'compatibility',
                  type: 'choice',
                  text: 'Which behavior must remain?',
                  options: ['CLI exit codes', 'Output format'],
                  default: 'CLI exit codes',
                },
              ],
        answers: [],
        answered: false,
      };
      const runWorkflow = vi.fn(async (options: RunWorkflowOptions): Promise<Summary> => {
        options.tuiSink?.({
          type: 'planner_status',
          ts: Date.now(),
          phase: 'researching',
          status: 'running',
        });
        if (reply.text !== '') {
          options.tuiSink?.({
            type: 'planner_text',
            ts: Date.now(),
            phase: 'researching',
            role: 'planner',
            content: 'plain',
            text: reply.text,
          });
        }
        const ask = options.callbacks.onPlannerReply;
        if (ask === undefined)
          throw new Error('Workflow did not install its planner reply callback');
        received(await ask(reply));
        return new Promise<Summary>(() => {});
      });
      ui = mountWorkflowScreen({ deps: { runWorkflow }, projectDir, rows: 40 });
      const screen = ui;
      await vi.waitFor(() => {
        const frame = stripAnsiStyles(screen.lastFrame());
        expect(frame).toContain('Which module should change?');
        if (kind === 'structured') {
          expect(frame).toContain('Question 1 of 2');
          expect(frame).not.toContain('Which behavior must remain?');
        } else {
          expect(frame.match(/Which module should change\?/g)).toHaveLength(1);
          expect(frame.match(/Reply to the planner…/g) ?? []).toHaveLength(1);
          expect(frame).not.toContain('Answer the planner…');
        }
        expect(frame).toContain('Waiting for your answer');
      });
      expect(received).not.toHaveBeenCalled();
      await flushEffects();
      const waitingFrame = stripAnsiStyles(screen.lastFrame());
      // The header's run clock keeps counting while the planner waits; nothing else moves.
      const workingClock = runClockOf(waitingFrame);
      expect(workingClock).not.toBeNull();
      await tick(1100);
      expect(withoutRunClock(stripAnsiStyles(screen.lastFrame()))).toBe(
        withoutRunClock(waitingFrame),
      );
      expect(runClockOf(stripAnsiStyles(screen.lastFrame()))).not.toBe(workingClock);

      await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      await flushEffects();
      screen.stdin.write('Refactor src/auth.ts; preserve CLI exit codes.');
      await flushEffects();
      screen.stdin.write('\r');
      if (kind === 'structured') {
        await vi.waitFor(() =>
          expect(stripAnsiStyles(screen.lastFrame())).toContain('Question 2 of 2'),
        );
        expect(received).not.toHaveBeenCalled();
        screen.stdin.write('\r');
      }
      await vi.waitFor(() => {
        expect(received).toHaveBeenCalledExactlyOnceWith(
          kind === 'ordinary'
            ? plainUserMessage('Refactor src/auth.ts; preserve CLI exit codes.')
            : {
                message: plainUserMessage(
                  '1. Which module should change?\nRefactor src/auth.ts; preserve CLI exit codes.\n\n2. Which behavior must remain?\nCLI exit codes',
                ),
                qa: [
                  {
                    question: 'Which module should change?',
                    answer: 'Refactor src/auth.ts; preserve CLI exit codes.',
                  },
                  { question: 'Which behavior must remain?', answer: 'CLI exit codes' },
                ],
              },
        );
        expect(controlsStore.get().inputMode).toBe('normal');
        expect(stripAnsiStyles(screen.lastFrame())).not.toContain('Waiting for your answer');
      });
    },
  );
  it('preserves custom drafts when going back and submits the edited batch once', async () => {
    const received = vi.fn();
    const runWorkflow = vi.fn(async (options: RunWorkflowOptions): Promise<Summary> => {
      received(
        await options.callbacks.onPlannerReply?.({
          call: 'research',
          text: '',
          answers: [],
          answered: false,
          questions: [
            { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
            { id: 'files', type: 'input', text: 'Which files?', default: 'src/' },
            { id: 'ready', type: 'confirm', text: 'Proceed?', default: false },
          ],
        }),
      );
      return new Promise<Summary>(() => {});
    });
    ui = mountWorkflowScreen({ deps: { runWorkflow }, projectDir, rows: 24 });
    const screen = ui;
    const key = async (value: string) => {
      screen.stdin.write(value);
      await flushEffects();
    };
    await vi.waitFor(() =>
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Question 1 of 3'),
    );
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    // Tab opens the answer field inside the question panel.
    await key('\t');
    expect(questionPromptStore.get().focus).toBe('answer');
    await key('Separate reviewer');
    await key('\t');
    expect(questionPromptStore.get().focus).toBe('menu');
    await key('\t');
    expect(stripAnsiStyles(screen.lastFrame())).toContain('Separate reviewer');
    await key('\r');
    await vi.waitFor(() =>
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Question 2 of 3'),
    );
    expect(stripAnsiStyles(screen.lastFrame())).toContain('src/');
    await key('auth.ts');
    await key('\t');
    await key('\r');
    expect(questionPromptStore.get().index).toBe(0);
    await key('\u001b[A'); // Replace custom answer with Builder.
    await key('\r');
    expect(questionPromptStore.get().index).toBe(1);
    expect(stripAnsiStyles(screen.lastFrame())).toContain('src/auth.ts');
    await key('\r');
    expect(questionPromptStore.get().index).toBe(2);
    expect(received).not.toHaveBeenCalled();
    await key('\r'); // Explicitly accept the false default.
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledExactlyOnceWith({
        message: plainUserMessage(
          '1. Which seat?\nBuilder\n\n2. Which files?\nsrc/auth.ts\n\n3. Proceed?\nNo',
        ),
        qa: [
          { question: 'Which seat?', answer: 'Builder' },
          { question: 'Which files?', answer: 'src/auth.ts' },
          { question: 'Proceed?', answer: 'No' },
        ],
      }),
    );
    expect(controlsStore.get().inputMode).toBe('normal');
  });
  it('answers inside the box and sends a separate instruction instead of the question batch', async () => {
    const received = vi.fn();
    const runWorkflow = vi.fn(async (options: RunWorkflowOptions): Promise<Summary> => {
      received(
        await options.callbacks.onPlannerReply?.({
          call: 'research',
          text: '',
          answers: [],
          answered: false,
          questions: [
            { id: 'target', type: 'input', text: 'Which module?' },
            {
              id: 'goal',
              type: 'choice',
              text: 'Which goal?',
              options: ['Simplify', 'Fix', 'Cleanup'],
              default: 'Cleanup',
            },
          ],
        }),
      );
      await options.callbacks.onPlannerReply?.({
        call: 'research',
        text: '',
        answers: [],
        answered: false,
        questions: [{ id: 'target', type: 'input', text: 'Which diff should I review?' }],
      });
      return new Promise<Summary>(() => {});
    });
    ui = mountWorkflowScreen({ deps: { runWorkflow }, projectDir, rows: 24 });
    const screen = ui;
    const key = async (value: string) => {
      screen.stdin.write(value);
      await flushEffects();
    };
    await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Which module?'));
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await key('src/auth.ts');
    const answering = stripAnsiStyles(screen.lastFrame());
    expect(answering.indexOf('src/auth.ts')).toBeLessThan(answering.indexOf('New instruction'));
    expect(answering).not.toContain('Write an answer');
    await key('\u001b[B');
    expect(questionPromptStore.get().focus).toBe('composer');
    await key('Review the current diff instead');
    expect(received).not.toHaveBeenCalled();
    await key('\t');
    expect(questionPromptStore.get().focus).toBe('answer');
    expect(questionPromptStore.get().drafts[0]?.text).toBe('src/auth.ts');
    await key('\u001b[B');
    await key('\r');
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledExactlyOnceWith(
        plainUserMessage('Review the current diff instead'),
      ),
    );
    await vi.waitFor(() =>
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Which diff should I review?'),
    );
    expect(questionPromptStore.get().drafts[0]?.text).toBe('');
    expect(questionPromptStore.get().answers).toEqual([]);
  });
});
