import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { mountWorkflowScreen, prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { Router } from '../../../src/app/router.js';
import { useAppKeys } from '../../../src/app/keys.js';
import { ThemeProvider } from '../../../src/components/theme.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { configStore } from '../../../src/stores/project/config.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { clearAllHandlers } from '../../../src/features/workflow/handlers.js';
import { cancelEscapeAction } from '../../../src/lib/terminal/escape-debounce.js';
import type { ClarificationQuestion } from '../../../src/core/schemas/question.js';
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
            metadata: {
              planner: 'Claude Code CLI · auto',
              implementer: 'test · auto',
              reviewer: 'Claude Code CLI · auto',
            },
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
      // The default is the first row; the second row opens an empty field for an answer of one's own.
      screen.stdin.write('\u001b[B');
      await flushEffects();
      screen.stdin.write('\r');
      await flushEffects();
      screen.stdin.write('src/auth.ts; preserve the public API.');
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
      // Nothing on screen moves while the planner waits on the answer.
      await tick(1100);
      expect(stripAnsiStyles(screen.lastFrame())).toBe(waitingFrame);

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
    expect(stripAnsiStyles(screen.lastFrame())).toContain('src/ default');
    await key('\u001b[B');
    await key('\r');
    expect(questionPromptStore.get().focus).toBe('answer');
    await key('src/auth.ts');
    await key('\t');
    await key('\u001b[B'); // Previous question.
    await key('\r');
    expect(questionPromptStore.get().index).toBe(0);
    await key('\u001b[A'); // Replace custom answer with Builder.
    await key('\r');
    expect(questionPromptStore.get().index).toBe(1);
    await key('\u001b[A'); // Back from Previous question to the write row, which kept its draft.
    await key('\r');
    expect(stripAnsiStyles(screen.lastFrame())).toContain('› src/auth.ts');
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
    expect(answering.indexOf('src/auth.ts')).toBeLessThan(
      answering.indexOf('Answer the question above…'),
    );
    expect(answering).not.toContain('Write your own answer');
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

function RoutedWorkflow({
  runWorkflow,
}: {
  runWorkflow: (options: RunWorkflowOptions) => Promise<Summary>;
}) {
  useAppKeys({
    exit: () => {
      throw new Error('Esc must not exit the app');
    },
  });
  const screen = routerStore.use((state) => state.screen);
  const overlay = overlayStore.use((state) => state.active);
  return (
    <ThemeProvider>
      <Router
        screen={screen}
        overlayActive={overlay}
        commands={[]}
        onRuntime={() => {}}
        workflowDeps={{ runWorkflow }}
      />
    </ThemeProvider>
  );
}

/** The workflow screen under the app keys, where Esc opens the stop sheet. */
function mountRoutedWorkflow(
  runWorkflow: (options: RunWorkflowOptions) => Promise<Summary>,
  rows = 40,
  cols = 120,
) {
  const config = makeConfig();
  const prepared = prepareWorkflowExecution({ projectDir, feature: 'Refactor', config });
  configStore.__testReset({ config, projectDir });
  terminalSizeStore.__testReset({ cols, rows, isSmall: false });
  routerStore.navigate({
    to: 'workflow',
    run: makeRunRecord({ ref: prepared.session.ref, feature: 'Refactor' }),
    execution: { kind: 'local', prepared },
  });
  return renderFeature(<RoutedWorkflow runWorkflow={runWorkflow} />, { cols, rows });
}

describe('Esc in a planner question', () => {
  afterEach(() => {
    vi.useRealTimers();
    cancelEscapeAction();
    clearAllHandlers();
  });

  const choice: ClarificationQuestion = {
    id: 'seat',
    type: 'choice',
    text: 'Which seat?',
    options: ['Planner', 'Builder'],
    default: 'Builder',
  };
  const confirm: ClarificationQuestion = {
    id: 'ready',
    type: 'confirm',
    text: 'Proceed?',
    default: false,
  };
  const input: ClarificationQuestion = {
    id: 'files',
    type: 'input',
    text: 'Which files?',
    default: 'src/',
  };
  const bare: ClarificationQuestion = { id: 'note', type: 'input', text: 'Anything to add?' };

  /**
   * Asks `rounds` in order; each round waits for its reply before the next one opens. `inGrace`
   * freezes the clock at the moment the panel opens, so the first key lands inside its typeahead
   * grace; `running: false` leaves the run without a running planner, where Esc has no stop sheet.
   */
  async function askRounds(
    rounds: readonly (readonly ClarificationQuestion[])[],
    opts: {
      conversation?: Partial<PlannerConversation>;
      inGrace?: boolean;
      running?: boolean;
      rows?: number;
      cols?: number;
    } = {},
  ) {
    if (opts.inGrace) vi.useFakeTimers({ toFake: ['Date'], now: 1_783_958_400_000 });
    const replies: unknown[] = [];
    const runWorkflow = async (options: RunWorkflowOptions): Promise<Summary> => {
      if (opts.running !== false) {
        options.tuiSink?.({
          type: 'planner_status',
          ts: Date.now(),
          phase: 'researching',
          status: 'running',
        });
      }
      for (const questions of rounds) {
        replies.push(
          await options.callbacks.onPlannerReply?.({
            call: 'research',
            text: '',
            answers: [],
            answered: false,
            questions: [...questions],
            ...opts.conversation,
          }),
        );
      }
      return new Promise<Summary>(() => {});
    };
    ui = mountRoutedWorkflow(runWorkflow, opts.rows, opts.cols);
    const screen = ui;
    const frame = () => stripAnsiStyles(screen.lastFrame());
    const key = async (value: string) => {
      screen.stdin.write(value);
      await flushEffects();
    };
    const first = rounds[0] ?? [];
    await vi.waitFor(() => expect(frame()).toContain(`Question 1 of ${first.length}`));
    if (!opts.inGrace) await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    return { replies, frame, key };
  }

  async function expectClosed(frame: () => string) {
    await vi.waitFor(() => expect(frame()).not.toMatch(/Question \d+ of/));
    expect(frame()).toContain('Type your answer…');
    expect(overlayStore.get().active).not.toBe('stop-sheet');
    expect(stopStore.get().intent).toBe('none');
  }

  async function replyInComposer(
    key: (value: string) => Promise<void>,
    replies: unknown[],
    text: string,
  ) {
    await key(text);
    await key('\r');
    await vi.waitFor(() => expect(replies).toEqual([plainUserMessage(text)]));
  }

  it.each([
    ['choice', choice],
    ['confirm', confirm],
    ['free-text with a default', input],
    ['free-text without a default', bare],
  ])(
    'closes the panel of a %s question on Esc and sends the composer reply',
    async (_kind, question) => {
      const { replies, frame, key } = await askRounds([[question]]);
      await key('\u001b');
      await expectClosed(frame);
      await replyInComposer(key, replies, 'Use the auth module');
    },
  );

  it('closes the panel on Esc from the write field and drops the text typed there', async () => {
    const { replies, frame, key } = await askRounds([[choice]]);
    await key('\u001b[B');
    await key('\u001b[B');
    await key('\r');
    expect(questionPromptStore.get().focus).toBe('answer');
    await key('half an answer');
    expect(frame()).toContain('› half an answer');
    await key('\u001b');
    await expectClosed(frame);
    expect(frame()).not.toContain('half an answer');
    await replyInComposer(key, replies, 'Use the auth module');
  });

  it('closes the panel on Esc at question 2 of 3 and sends the reply alone', async () => {
    const { replies, frame, key } = await askRounds([[choice, input, confirm]]);
    await key('\r');
    await vi.waitFor(() => expect(frame()).toContain('Question 2 of 3'));
    await key('\u001b');
    await expectClosed(frame);
    await replyInComposer(key, replies, 'Skip the rest, use the defaults');
  });

  it('closes the paused panel on Esc after ↓ moved the keys to the composer', async () => {
    const { replies, frame, key } = await askRounds([[choice]]);
    await key('\u001b[B');
    await key('\u001b[B');
    await key('\u001b[B');
    expect(questionPromptStore.get().focus).toBe('composer');
    await key('\u001b');
    await expectClosed(frame);
    await replyInComposer(key, replies, 'Use the auth module');
  });

  it('opens the stop sheet on a second Esc once the panel is closed', async () => {
    const { frame, key } = await askRounds([[choice]]);
    await key('\u001b');
    await expectClosed(frame);
    await key('\u001b');
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('stop-sheet'));
    expect(frame()).toContain('Stop options');
    expect(stopStore.get().intent).toBe('none');
  });

  it('closes the panel and opens the stop sheet on a fast double Esc, without stopping', async () => {
    const { frame, key } = await askRounds([[choice]]);
    await key('\u001b\u001b');
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('stop-sheet'));
    expect(questionPromptStore.get().questions).toEqual([]);
    expect(frame()).not.toContain('Question 1 of');
    expect(stopStore.get().intent).toBe('none');
  });

  describe('inside the typeahead grace after the panel opens', () => {
    const sinceOpen = () => Date.now() - questionPromptStore.get().openedAt;
    const leaveGrace = () =>
      vi.setSystemTime(questionPromptStore.get().openedAt + PROMPT_TYPEAHEAD_GRACE_MS);

    async function expectStopSheetOverPanel(frame: () => string, count = 1) {
      await vi.waitFor(() => expect(overlayStore.get().active).toBe('stop-sheet'));
      expect(questionPromptStore.get().questions).toHaveLength(count);
      expect(stopStore.get().intent).toBe('none');
      expect(frame()).not.toContain('Unanswered ·');
    }

    it('opens the stop sheet and keeps the panel on an Esc over the rows', async () => {
      const { frame, key } = await askRounds([[choice]], { inGrace: true });
      expect(questionPromptStore.get().focus).toBe('menu');
      expect(sinceOpen()).toBeLessThan(PROMPT_TYPEAHEAD_GRACE_MS);
      await key('\u001b');
      await expectStopSheetOverPanel(frame);
    });

    it('opens the stop sheet and keeps the panel on an Esc in the answer field', async () => {
      const { frame, key } = await askRounds([[bare]], { inGrace: true });
      expect(questionPromptStore.get().focus).toBe('answer');
      await key('\u001b');
      await expectStopSheetOverPanel(frame);
    });

    it('closes the panel on an Esc the moment the grace ends', async () => {
      const { frame, key } = await askRounds([[choice]], { inGrace: true });
      leaveGrace();
      await key('\u001b');
      await expectClosed(frame);
    });

    it('stops at once on a double Esc, without closing the panel first', async () => {
      const { key } = await askRounds([[choice]], { inGrace: true });
      const close = vi.spyOn(questionPromptStore, 'close');
      await key('\u001b\u001b');
      await vi.waitFor(() => expect(stopStore.get().intent).not.toBe('none'));
      expect(close).not.toHaveBeenCalled();
    });

    it('does nothing on an Esc where the screen has no stop sheet to open', async () => {
      const { frame, key } = await askRounds([[choice]], { inGrace: true, running: false });
      await key('\u001b');
      await tick(60);
      expect(overlayStore.get().active).not.toBe('stop-sheet');
      expect(questionPromptStore.get().questions).toHaveLength(1);
      expect(frame()).toContain('Question 1 of 1');
    });

    it('keeps round 2 inside its own grace, and closes it once that grace ends', async () => {
      const { replies, frame, key } = await askRounds([[choice], [confirm]], { inGrace: true });
      leaveGrace();
      await key('\u001b');
      await expectClosed(frame);
      await replyInComposer(key, replies, 'Use the auth module');
      await vi.waitFor(() => expect(frame()).toContain('Proceed?'));
      expect(sinceOpen()).toBeLessThan(PROMPT_TYPEAHEAD_GRACE_MS);
      await key('\u001b');
      await expectStopSheetOverPanel(frame);
      await key('\t');
      await vi.waitFor(() => expect(overlayStore.get().active).not.toBe('stop-sheet'));
      leaveGrace();
      await key('\u001b');
      await expectClosed(frame);
    });

    it.each([
      ['the final review', {}],
      ['a consult seat', { seat: 'review' as const }],
    ])('keeps the panel of %s on an Esc inside the grace', async (_asker, conversation) => {
      const { frame, key } = await askRounds([[bare]], { inGrace: true, conversation });
      await key('\u001b');
      await expectStopSheetOverPanel(frame);
    });

    it('closes the paused panel on an Esc after the grace', async () => {
      const { frame, key } = await askRounds([[choice]], { inGrace: true });
      leaveGrace();
      await key('\u001b[B');
      await key('\u001b[B');
      await key('\u001b[B');
      expect(questionPromptStore.get().focus).toBe('composer');
      await key('\u001b');
      await expectClosed(frame);
    });
  });

  describe('the round Esc closed, in the transcript', () => {
    const count = (frame: string, text: string) => frame.split(text).length - 1;
    const headerLine = (frame: string, text: string) =>
      frame.split('\n').find((line) => line.includes(text)) ?? '';

    it('shows the open round only in the panel', async () => {
      const { frame } = await askRounds([[choice, confirm]]);
      expect(frame()).not.toContain('Unanswered ·');
      expect(count(frame(), 'Which seat?')).toBe(1);
    });

    it('lists the round as unanswered, with each option and no mark, after Esc on round 1', async () => {
      const { frame, key } = await askRounds([[choice]]);
      await key('\u001b');
      await expectClosed(frame);
      expect(frame()).toContain('Unanswered · 1 question');
      expect(headerLine(frame(), 'Unanswered · 1 question')).not.toContain('❯');
      expect(count(frame(), '· Which seat? (Planner / Builder)')).toBe(1);
    });

    it('lists round 2 after Esc on round 2, and drops round 1 from the live tail', async () => {
      const { replies, frame, key } = await askRounds([[choice], [confirm]]);
      await key('\u001b');
      await expectClosed(frame);
      await replyInComposer(key, replies, 'Use the auth module');
      await vi.waitFor(() => expect(frame()).toContain('Proceed?'));
      await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      await key('\u001b');
      await expectClosed(frame);
      expect(frame()).toContain('Unanswered · 1 question');
      expect(frame()).toContain('· Proceed? (yes / no)');
      expect(frame()).not.toContain('· Which seat?');
    });

    it('lists every question of the round after Esc at question 2 of 3', async () => {
      const { frame, key } = await askRounds([[choice, input, confirm]]);
      await key('\r');
      await vi.waitFor(() => expect(frame()).toContain('Question 2 of 3'));
      await key('\u001b');
      await expectClosed(frame);
      expect(frame()).toContain('Unanswered · 3 questions');
      expect(frame()).toContain('· Which seat? (Planner / Builder)');
      expect(frame()).toContain('· Which files?');
      expect(frame()).toContain('· Proceed? (yes / no)');
    });

    it('drops the round from the live tail when an empty ⏎ takes the defaults', async () => {
      const { replies, frame, key } = await askRounds([[choice]]);
      await key('\u001b');
      await expectClosed(frame);
      await key('\r');
      await vi.waitFor(() => expect(replies).toEqual([plainUserMessage('')]));
      await vi.waitFor(() => expect(frame()).not.toContain('Unanswered ·'));
    });

    const askers = [
      ['the planner', {}],
      ['the final review', { call: 'plan' as const }],
      ['a consult seat', { seat: 'review' as const }],
    ] as const;

    it.each(askers)(
      'lists the round of %s as unanswered while its reply is typed, never declined',
      async (_asker, conversation) => {
        const { replies, frame, key } = await askRounds([[bare]], { conversation });
        await key('\u001b');
        await vi.waitFor(() => expect(frame()).toContain('Unanswered · 1 question'));
        expect(count(frame(), 'Anything to add?')).toBe(1);
        expect(frame()).not.toContain('Declined');
        await key('Nothing more');
        await key('\r');
        await vi.waitFor(() => expect(replies).toEqual([plainUserMessage('Nothing more')]));
        await vi.waitFor(() => expect(frame()).not.toContain('Unanswered ·'));
        expect(frame()).not.toContain('Declined');
      },
    );

    it.each(askers)(
      'adds no round row for %s when the instruction composer answers the open panel',
      async (_asker, conversation) => {
        const { replies, frame, key } = await askRounds([[bare]], { conversation });
        await key('\u001b[B');
        expect(questionPromptStore.get().focus).toBe('composer');
        await key('Nothing more');
        await key('\r');
        await vi.waitFor(() => expect(replies).toEqual([plainUserMessage('Nothing more')]));
        expect(frame()).not.toContain('Unanswered ·');
        expect(frame()).not.toContain('Declined');
      },
    );

    it('keeps the question text off the byline', async () => {
      const { frame, key } = await askRounds([[choice]]);
      await key('\u001b');
      await expectClosed(frame);
      const byline = frame()
        .split('\n')
        .filter((line) => line.includes('Waiting for your answer'));
      expect(byline.length).toBeGreaterThan(0);
      for (const line of byline) expect(line).not.toContain('Which seat?');
    });

    it('keeps the composer on screen with the round at 60x18', async () => {
      const { frame, key } = await askRounds([[choice, input]], { rows: 18, cols: 60 });
      await key('\u001b');
      await vi.waitFor(() => expect(frame()).toContain('Unanswered · 2 questions'));
      expect(frame()).toContain('Type your answer…');
      expect(frame()).toContain('· Which files?');
    });
  });

  it('opens the next round on its rows after a reply sent past a closed panel', async () => {
    const { replies, frame, key } = await askRounds([[choice], [confirm]]);
    await key('\u001b');
    await expectClosed(frame);
    await replyInComposer(key, replies, 'Use the auth module');
    await vi.waitFor(() => expect(frame()).toContain('Proceed?'));
    expect(frame()).toContain('Question 1 of 1');
    expect(questionPromptStore.get().focus).toBe('menu');
  });

  it('takes the reply typed after Esc as the answer of the round, and the planner goes on to the plan', async () => {
    const invocations = join(projectDir, 'invocations.json');
    const shim = join(projectDir, 'claude');
    const answers = [
      {
        kind: 'questions',
        questions: [
          {
            id: 'module',
            text: 'Which module should change?',
            choices: ['src/auth.ts', 'src/session.ts'],
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
const emit = (frame) => console.log(JSON.stringify({session_id: 'native-esc', ...frame}));
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
    const finished = Promise.withResolvers<string>();
    let runRef = { projectDir, sessionId: '' };
    const runWorkflow = async (options: RunWorkflowOptions): Promise<Summary> => {
      const ref = options.prepared.session.ref;
      runRef = ref;
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
            metadata: {
              planner: 'Claude Code CLI · auto',
              implementer: 'test · auto',
              reviewer: 'Claude Code CLI · auto',
            },
            signal: options.signal,
          },
          state,
          planner,
          feature: state.feature,
        });
        finished.resolve(result.disposition);
        return makeSummary();
      } catch (cause) {
        finished.resolve(String(cause));
        throw cause;
      }
    };
    ui = mountRoutedWorkflow(runWorkflow);
    const screen = ui;
    const frame = () => stripAnsiStyles(screen.lastFrame());
    await vi.waitFor(() => expect(frame()).toContain('Question 1 of 1'), { timeout: 3000 });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    screen.stdin.write('\u001b');
    await vi.waitFor(() => expect(frame()).not.toContain('Question 1 of 1'));
    const roundLine = '· Which module should change? (src/auth.ts / src/session.ts)';
    expect(frame()).toContain('Unanswered · 1 question');
    expect(frame()).toContain(roundLine);
    screen.stdin.write('Change src/session.ts and keep the public API.');
    await flushEffects();
    screen.stdin.write('\r');
    expect(await finished.promise).toBe('tasks-ready');
    await vi.waitFor(() =>
      expect(frame()).toContain('Change src/session.ts and keep the public API.'),
    );
    const reply = 'You → Change src/session.ts and keep the public API.';
    expect(frame()).toContain('Answered · 1 question');
    expect(frame()).toContain('· Which module should change?');
    expect(frame()).not.toContain('1. Which module should change?');
    expect(frame().split('Change src/session.ts and keep the public API.')).toHaveLength(2);
    expect(frame()).toContain(reply);
    expect(frame()).not.toContain(roundLine);
    expect(frame()).not.toContain('Unanswered ·');
    expect(frame()).not.toContain('Declined');
    const replay = await readRunEvents(runRef);
    expect(replay.events.map((event) => event.type)).not.toContain('questions_declined');
    const replayed = replay.events.filter((event) => event.type === 'user_message');
    expect(replayed).toEqual([
      expect.objectContaining({
        text: 'Change src/session.ts and keep the public API.',
        questions: [expect.objectContaining({ text: 'Which module should change?' })],
      }),
    ]);
    const rows = replayed.flatMap((event, globalIndex) => {
      const block = eventRowBlock({
        event,
        globalIndex,
        ctx: { width: 80, viewportRows: 20, streaming: { taskId: null, lines: [], active: false } },
        expanded: false,
      });
      return (block?.createRows(0, block.rowCount) ?? []).map((row) =>
        row.segments.map((segment) => segment.text).join(''),
      );
    });
    expect(rows).toEqual(['Answered · 1 question', '· Which module should change?', reply]);
    const calls: unknown = JSON.parse(readFileSync(invocations, 'utf8'));
    expect(calls).toEqual([
      expect.anything(),
      expect.objectContaining({
        args: expect.arrayContaining(['--resume', 'native-esc']),
        prompt: expect.stringContaining('Change src/session.ts and keep the public API.'),
      }),
    ]);
    expect(overlayStore.get().active).not.toBe('stop-sheet');
  });
});
