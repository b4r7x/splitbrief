import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import {
  CONFIRM_PHRASE,
  type TieredApprovalRequest,
  type TieredApprovalResponse,
} from '../../../src/core/approval/types.js';
import {
  CONFIRM_REASON_UNSTATED,
  PROMPT_COMMAND_LEGEND,
  formatApprovalActionDescription,
} from '../../../src/features/workflow/prompt-rows/approval.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import type { ReviewInputEffects } from '../../../src/features/workflow/review-gate/input-handler.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { RuntimeCommandDef } from '../../../src/core/runtime/commands/types.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { draftDocumentText, inputHistoryStore } from '../../../src/stores/ui/input-history.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import type { Phase } from '../../../src/core/schemas/enums.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { listRowLead } from '../../../src/components/list-row/lead.js';
import { setStopHandler } from '../../../src/features/workflow/run-requests/handlers.js';
import { mountWorkflowScreen, prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { createMockFilteredStdin, pointerEvent } from '#testing/helpers/mouse-zones.js';
import { wireAppMouse } from '../../../src/app/mouse.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };
let projectDir = '';

const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { lifecycleStore } = await import('../../../src/stores/workflow/lifecycle/state.js');
const { runViewStore } = await import('../../../src/stores/workflow/run-view.js');
const { openApprovalPrompt } = await import('../../../src/stores/prompts/approval.js');

const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

const CONFIRMED = {
  decision: 'confirm',
  phrase: CONFIRM_PHRASE,
  reason: CONFIRM_REASON_UNSTATED,
} as const;

function confirmRequest(): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass: 'package_change',
    actionDescription: 'write package.json',
    phase: 'implementing',
  };
}

function mountWorkflow(rows = 60) {
  return mountWorkflowScreen({ deps: workflowDeps, projectDir, rows });
}

function legendRows(frame: string): string[] {
  return stripAnsiStyles(frame)
    .split('\n')
    .filter((line) => line.includes('back to the actions'))
    .map((line) => line.trim().slice(1, -1).trim());
}

describe('WorkflowScreen key ownership', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.init({ screen: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
    projectDir = createTempDir('workflow-screen-key-ownership');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetAllStores();
    routerStore.init({ screen: 'home' });
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('a pending approval prompt owns the keystroke; the focused composer does not capture it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openApprovalPrompt(confirmRequest());
    await tick(PAST_GRACE);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('Confirm with a reason');

    // A single 'y' must produce exactly one semantic action: the prompt's confirm.
    // If the composer were still focused it would also append 'y' to the input box.
    await flushEffects();
    ui.stdin.write('y');
    await expect(decision).resolves.toEqual(CONFIRMED);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    // The composer's input row never received the 'y' (it stayed on the placeholder hint).
    expect(frame).not.toMatch(/>\s+y(\s|$)/m);

    ui.unmount();
  });
  it('keeps a pending approval prompt answerable on a terminal too short to render it', async () => {
    // rows=6 with the default 3-row composer leaves no middle budget, so the prompt clamps to
    // zero rows. The handler must still be registered or the prompt deadlocks unanswerably.
    // With no row in view `y` confirms nothing; a denial takes no row.
    const ui = mountWorkflow(6);
    await tick(20);

    const decision = openApprovalPrompt(confirmRequest());
    await tick(PAST_GRACE);
    await flushEffects();
    let settled = false;
    void decision.then(() => {
      settled = true;
    });

    ui.stdin.write('y');
    await tick(20);
    expect(settled).toBe(false);

    ui.stdin.write('x');
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });

    ui.unmount();
  });

  it('ignores a keystroke buffered into the grace window, then honours it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const openedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(openedAt);
    const decision = openApprovalPrompt(confirmRequest());
    await tick(20);

    // The 'x' arrives inside the grace window (a keystroke meant for the composer that was
    // in flight when the prompt opened). It must not deny the prompt.
    await flushEffects();
    ui.stdin.write('x');
    await tick(20);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(20);
    expect(settled).toBe(false);

    clock.mockReturnValue(openedAt + PAST_GRACE);
    await flushEffects();
    ui.stdin.write('x');
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });

    ui.unmount();
  });

  it('the composer captures a printable key while no review prompt is active', async () => {
    const ui = mountWorkflow();
    await tick(20);

    // Control: outside brief review the composer owns printable keystrokes.
    await flushEffects();
    ui.stdin.write('j');
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} j`);

    ui.unmount();
  });
  it('the composer still captures printable keys during the reviewing-briefs phase', async () => {
    const ui = mountWorkflow();
    await tick(20);

    runViewStore.__testReset({ phase: 'reviewing-briefs' });
    lifecycleStore.__testReset({ status: 'running' });
    await flushEffects();

    ui.stdin.write('j');
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} j`);

    ui.unmount();
  });

  describe('a gate that opens while BUILD runs', () => {
    const DRAFT = 'also fix the typo';
    const enqueue = vi.fn<ReviewInputEffects['enqueue']>();

    function mountCommandScreen(
      deps: WorkflowScreenDeps,
      commands: RuntimeCommandDef[],
      onRuntimeCommand: (command: string) => void,
    ) {
      const config = makeConfig();
      const feature = 'screen test feature';
      const prepared = prepareWorkflowExecution({ projectDir, feature, config });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord({ ref: prepared.session.ref, feature }),
        execution: { kind: 'local', prepared },
      });
      return renderFeature(
        <WorkflowScreen commands={commands} onRuntimeCommand={onRuntimeCommand} deps={deps} />,
        { cols: 120, rows: 60 },
      );
    }

    type GateMount = (deps: WorkflowScreenDeps) => ReturnType<typeof renderFeature>;

    // The clock stops at the open and then moves past the grace, so every key after that is one
    // the user typed with the gate on screen.
    async function openGate(
      draft: string,
      phase: Phase = 'implementing',
      request = confirmRequest(),
      mount: GateMount = (deps) => mountWorkflowScreen({ deps, projectDir }),
    ) {
      enqueue.mockReset();
      enqueue.mockResolvedValue({ status: 'accepted', messageId: 'queued-1' });
      const deps: WorkflowScreenDeps = {
        runWorkflow,
        reviewInput: { openExternalEditor: async () => {}, enqueue },
      };
      const ui = mount(deps);
      await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalled());
      runViewStore.__testReset({ phase });
      lifecycleStore.__testReset({ status: 'running' });
      await flushEffects();
      if (draft !== '') {
        ui.stdin.write(draft);
        await vi.waitFor(() => expect(composerLiveStore.get().text).toBe(draft));
        await flushEffects();
      }
      const openedAt = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(openedAt);
      const framesBefore = ui.frames.length;
      let settled: TieredApprovalResponse | undefined;
      void openApprovalPrompt(request).then((response) => {
        settled = response;
      });
      await vi.waitFor(() => expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Deny'));
      const firstFrame =
        ui.frames
          .slice(framesBefore)
          .map((frame) => stripAnsiStyles(frame))
          .find((frame) => frame.includes('Deny')) ?? '';
      clock.mockReturnValue(openedAt + PAST_GRACE);
      await flushEffects();
      return {
        ui,
        // Inside the panel border: the ASCII live bar is the same `|` as the border.
        firstGateRows: firstFrame
          .split('\n')
          .filter((line) => /Confirm|Deny/.test(line))
          .map((line) => line.trim().slice(1, -1)),
        settled: () => settled,
      };
    }

    it('over a draft paints its first frame with no ▌ on a gate row', async () => {
      const gate = await openGate(DRAFT);
      expect(gate.firstGateRows).toHaveLength(3);
      expect(gate.firstGateRows.filter((row) => row.includes(glyph('liveBar')))).toEqual([]);
      gate.ui.unmount();
    });

    it.each(['y', 'n', 'x', 'r'])(
      'over a draft keeps %s in the draft after the grace and keeps waiting',
      async (letter) => {
        const gate = await openGate(DRAFT);
        gate.ui.stdin.write(letter);
        await vi.waitFor(() =>
          expect({ text: composerLiveStore.get().text, settled: gate.settled() }).toEqual({
            text: `${DRAFT}${letter}`,
            settled: undefined,
          }),
        );
        gate.ui.unmount();
      },
    );

    it('over a draft queues the draft on ⏎ after the grace and keeps waiting', async () => {
      const gate = await openGate(DRAFT);
      gate.ui.stdin.write('\r');
      await vi.waitFor(() =>
        expect({
          sent: enqueue.mock.calls.map(([message]) => message.displayText),
          settled: gate.settled(),
        }).toEqual({ sent: [DRAFT], settled: undefined }),
      );
      gate.ui.unmount();
    });

    it.each(['complete', 'reviewing-plan'] as const)(
      'over a draft in %s, where no seat takes queued words, keeps the draft on ⏎ and promises no queue',
      async (phase) => {
        const words = 'keep the parser';
        const gate = await openGate(words, phase, {
          tier: 'confirm',
          actionClass: 'runner_trust',
          actionDescription: 'Executable: "tools/review-bot"\nArguments: "--diff"',
          phase,
        });
        const legend = stripAnsiStyles(gate.ui.lastFrame() ?? '')
          .split('\n')
          .filter((line) => line.includes('tab back to the actions'))
          .map((line) => line.trim().slice(1, -1).trim());
        expect(legend).toEqual(['tab back to the actions']);
        gate.ui.stdin.write('\r');
        await vi.waitFor(() =>
          expect(inputHistoryStore.get().entries.map(draftDocumentText)).toContain(words),
        );
        await flushEffects();
        await vi.waitFor(() =>
          expect({ text: composerLiveStore.get().text, settled: gate.settled() }).toEqual({
            text: words,
            settled: undefined,
          }),
        );
        expect(enqueue).not.toHaveBeenCalled();
        gate.ui.unmount();
      },
    );

    it('over an empty composer confirms on ⏎ after the grace', async () => {
      const gate = await openGate('');
      gate.ui.stdin.write('\r');
      await vi.waitFor(() => expect(gate.settled()).toEqual(CONFIRMED));
      expect(enqueue).not.toHaveBeenCalled();
      gate.ui.unmount();
    });

    it('gives the prompt the keys on ⏎ once the draft is deleted', async () => {
      const gate = await openGate(DRAFT);
      let remaining = DRAFT;
      for (const _ of DRAFT) {
        remaining = remaining.slice(0, -1);
        gate.ui.stdin.write('\b');
        await flushEffects();
        await vi.waitFor(() => expect(composerLiveStore.get().text).toBe(remaining));
      }
      await vi.waitFor(() =>
        expect(legendRows(gate.ui.lastFrame() ?? '')).toEqual(['tab/⏎ back to the actions']),
      );
      expect(stripAnsiStyles(gate.ui.lastFrame() ?? '')).not.toContain(
        `${listRowLead('active')}y   Confirm`,
      );

      gate.ui.stdin.write('\r');
      await vi.waitFor(() =>
        expect(stripAnsiStyles(gate.ui.lastFrame() ?? '')).toContain(
          `${listRowLead('active')}y   Confirm`,
        ),
      );
      expect(gate.settled()).toBeUndefined();
      expect(enqueue).not.toHaveBeenCalled();
      gate.ui.unmount();
    });

    it('names the command for a slash draft, runs it on ⏎, and keeps the prompt open', async () => {
      const dispatched: string[] = [];
      const commands: RuntimeCommandDef[] = [
        {
          kind: 'noarg',
          name: '/help',
          label: 'Help',
          description: 'Show help',
          category: 'navigate',
          validScreens: ['workflow'],
          handler: () => {},
        },
      ];
      const gate = await openGate('/help ', 'implementing', confirmRequest(), (deps) =>
        mountCommandScreen(deps, commands, (command) => dispatched.push(command)),
      );

      await vi.waitFor(() =>
        expect(legendRows(gate.ui.lastFrame() ?? '')).toEqual([
          `${PROMPT_COMMAND_LEGEND} · tab back to the actions`,
        ]),
      );

      gate.ui.stdin.write('\r');
      await vi.waitFor(() =>
        expect({ dispatched, settled: gate.settled() }).toEqual({
          dispatched: ['/help'],
          settled: undefined,
        }),
      );
      expect(enqueue).not.toHaveBeenCalled();
      expect(stripAnsiStyles(gate.ui.lastFrame() ?? '')).toContain('Change a package manifest:');
      gate.ui.unmount();
    });

    it('reads the composer again when a second prompt with the same task and action opens', async () => {
      const request: TieredApprovalRequest = { ...confirmRequest(), taskId: taskId('T001') };
      const gate = await openGate('', 'implementing', request);

      gate.ui.stdin.write('x');
      await vi.waitFor(() =>
        expect(gate.settled()).toEqual({ decision: 'deny', reason: 'user_denied' }),
      );
      await vi.waitFor(() =>
        expect(stripAnsiStyles(gate.ui.lastFrame() ?? '')).not.toContain('Deny'),
      );
      await flushEffects();

      gate.ui.stdin.write(DRAFT);
      await vi.waitFor(() => expect(composerLiveStore.get().text).toBe(DRAFT));
      await flushEffects();

      let second: TieredApprovalResponse | undefined;
      void openApprovalPrompt(request).then((response) => {
        second = response;
      });
      await vi.waitFor(() =>
        expect(stripAnsiStyles(gate.ui.lastFrame() ?? '')).toContain('Change a package manifest:'),
      );

      const frame = stripAnsiStyles(gate.ui.lastFrame() ?? '');
      expect(frame).not.toContain(`${listRowLead('active')}y   Confirm`);
      expect(legendRows(frame)).toEqual([
        '⏎ queues the typed correction · tab back to the actions',
      ]);

      gate.ui.stdin.write('\r');
      await vi.waitFor(() =>
        expect({
          sent: enqueue.mock.calls.map(([message]) => message.displayText),
          settled: second,
        }).toEqual({ sent: [DRAFT], settled: undefined }),
      );
      gate.ui.unmount();
    });

    it('sends the draft now on ctrl+⏎ and keeps the prompt open', async () => {
      const gate = await openGate(DRAFT);
      const stopped = vi.fn();
      setStopHandler(stopped);

      gate.ui.stdin.write('\x1b[13;5u');
      await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect({
          sent: enqueue.mock.calls.map(([message]) => message.displayText),
          settled: gate.settled(),
          text: composerLiveStore.get().text,
        }).toEqual({ sent: [], settled: undefined, text: '' }),
      );
      expect(inputHistoryStore.get().entries.map(draftDocumentText)).toContain(DRAFT);
      expect(stripAnsiStyles(gate.ui.lastFrame() ?? '')).toContain('Change a package manifest:');
      gate.ui.unmount();
    });
  });

  describe('a click on the confirm panel', () => {
    const trustRequest: TieredApprovalRequest = {
      tier: 'confirm',
      actionClass: 'runner_trust',
      actionDescription: 'Executable: "tools/review-bot"\nArguments: "--diff"',
      phase: 'planning',
    };

    async function openPanel(rows: number, request: TieredApprovalRequest) {
      const mouse = createMockFilteredStdin();
      const disposeMouse = wireAppMouse(mouse.filtered);
      const ui = mountWorkflow(rows);
      await tick(20);
      let settled: TieredApprovalResponse | undefined;
      void openApprovalPrompt(request).then((response) => {
        settled = response;
      });
      await tick(PAST_GRACE);
      await flushEffects();
      const lines = () => stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      const rowOf = (text: string) => lines().findIndex((line) => line.includes(text)) + 1;
      // The panel sits between the header rule and the rule above the composer.
      const panelRows = () => {
        const rules = lines().flatMap((line, index) => (/^-{40,}$/.test(line) ? [index] : []));
        const [top = 0, bottom = 0] = rules;
        return Array.from({ length: bottom - top - 1 }, (_, offset) => top + offset + 2);
      };
      return {
        settled: () => settled,
        rowOf,
        panelRows,
        click: (row: number) => mouse.emit(pointerEvent('press', 10, row)),
        close: () => {
          disposeMouse();
          ui.unmount();
        },
      };
    }

    it.each([
      ['y   Confirm', { decision: 'confirm', phrase: CONFIRM_PHRASE }],
      ['x   Deny', { decision: 'deny', reason: 'user_denied' }],
    ])('on the painted %s row takes that row', async (row, expected) => {
      const panel = await openPanel(24, trustRequest);
      panel.click(panel.rowOf(row));
      await vi.waitFor(() => expect(panel.settled()).toMatchObject(expected), 1000);
      panel.close();
    });

    it('on the blank row or the legend does nothing', async () => {
      const panel = await openPanel(24, trustRequest);
      panel.click(panel.rowOf('x   Deny') + 1);
      panel.click(panel.rowOf('↑↓ select'));
      await tick(20);
      expect(panel.settled()).toBeUndefined();
      panel.click(panel.rowOf('x   Deny'));
      await vi.waitFor(() => expect(panel.settled()).toMatchObject({ decision: 'deny' }), 1000);
      panel.close();
    });

    describe.each([12, 14, 16])('in a 120x%i terminal', (rows) => {
      const cases = [
        ['runner trust', trustRequest, ['y   Confirm', 'x   Deny']],
        [
          'package manifest',
          confirmRequest(),
          ['y   Confirm', 'r   Confirm with a reason', 'x   Deny'],
        ],
      ] as const;

      it.each(cases)(
        'paints the %s action and every option, and only an option row answers',
        async (_, request, options) => {
          const panel = await openPanel(rows, request);
          const optionRows = options.map(panel.rowOf);
          expect(optionRows).not.toContain(0);
          const actionRow = panel.rowOf(
            formatApprovalActionDescription(request.actionDescription).split('\n')[0] ?? '',
          );
          expect(panel.panelRows()).toContain(actionRow);
          panel.click(actionRow);
          for (const row of panel.panelRows()) {
            if (!optionRows.includes(row)) panel.click(row);
          }
          await tick(20);
          expect(panel.settled()).toBeUndefined();
          expect(options.map(panel.rowOf)).toEqual(optionRows);
          panel.click(panel.rowOf('y   Confirm'));
          await vi.waitFor(
            () =>
              expect(panel.settled()).toMatchObject({
                decision: 'confirm',
                phrase: CONFIRM_PHRASE,
              }),
            1000,
          );
          panel.close();
        },
      );

      it.each(cases)('denies on the %s Deny row', async (_, request) => {
        const panel = await openPanel(rows, request);
        panel.click(panel.rowOf('x   Deny'));
        await vi.waitFor(
          () => expect(panel.settled()).toEqual({ decision: 'deny', reason: 'user_denied' }),
          1000,
        );
        panel.close();
      });
    });
  });
});
