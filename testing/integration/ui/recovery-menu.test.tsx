import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { configStore } from '../../../src/stores/project/config.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { requestEndRun } from '../../../src/features/workflow/handlers.js';
import { buildApplyPartialRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/apply.js';

let projectDir = '';
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  projectDir = createTempDir('recovery-menu-screen');
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(projectDir);
});

describe('recovery menu and composer keyboard ownership', () => {
  it.each(['panel', 'command'])(
    'ends a usage-limit halt through the %s and keeps the composer empty',
    async (action) => {
      const ref = { projectDir, sessionId: 'recover-usage-limit' };
      ensureSessionDir(projectDir, ref.sessionId);
      saveState(
        ref,
        makeWorkflowState({
          ...RUN_CREW,
          phase: 'implementing',
          pendingRecovery: makeRecoveryIssue({
            reason: 'runner-usage-limit',
            phase: 'implementing',
            facts: { tool: 'OpenCode CLI', cause: 'balance' },
            availableActions: ['retry-same-worker', 'end-run'],
            recommendedAction: 'retry-same-worker',
          }),
        }),
      );
      const saved = loadState(ref);
      if (saved === null) throw new Error('Missing fixture state');
      const config = makeConfig();
      const prepared = prepareWorkflowExecution({
        ...ref,
        config,
        feature: saved.feature,
        resumeState: saved,
      });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord({ ref, feature: saved.feature }),
        execution: { kind: 'local', prepared },
      });
      const runWorkflow = vi.fn(() => new Promise<Summary>(() => {}));
      ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={() => {}} deps={{ runWorkflow }} />,
      );
      const screen = ui;
      await vi.waitFor(() => {
        expect(stripAnsiStyles(screen.lastFrame())).toContain('End run');
        expect(stripAnsiStyles(screen.lastFrame())).toContain('Choose an action above');
      });
      await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      await flushEffects();

      if (action === 'panel') screen.stdin.write('a');
      else expect(requestEndRun()).toBe(true);

      await vi.waitFor(() => expect(loadState(ref)?.closed?.as).toBe('ended'));
      await vi.waitFor(() => expect(readSession(ref)?.status).toBe('ended'));
      expect(readActive(projectDir)).toBeNull();
      await flushEffects();
      expect(loadState(ref)?.pendingRecovery).toBeUndefined();
      expect(composerLiveStore.get()).toEqual({
        empty: true,
        text: '',
        document: createDraftDocument(''),
      });
      expect(runWorkflow).not.toHaveBeenCalled();
      const replay = await readRunEvents(ref);
      const actions = replay.events.filter((event) => event.type === 'recovery_action_selected');
      expect(actions).toHaveLength(1);
      expect(actions[0]?.action).toBe('end-run');
      expect(replay.events.filter((event) => event.type === 'recovery_resolved')).toEqual([
        expect.objectContaining({ action: 'end-run', outcome: 'aborted' }),
      ]);
      expect(replay.events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
    },
  );

  it('keeps spaces in the draft, then applies the correction from the composer', async () => {
    const ref = { projectDir, sessionId: 'recover-planning' };
    ensureSessionDir(projectDir, ref.sessionId);
    saveState(
      ref,
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'researching',
        pendingRecovery: makeRecoveryIssue({
          reason: 'planner-call-failed',
          seat: 'plan',
          phase: 'researching',
          taskId: undefined,
          taskTitle: undefined,
          selectedImplementerProfile: undefined,
          files: [],
          affectedTaskIds: [],
          message: 'The planner call failed.',
          details: [],
          availableActions: ['retry-same-worker', 'end-run'],
          recommendedAction: 'retry-same-worker',
        }),
      }),
    );
    const saved = loadState(ref);
    if (saved === null) throw new Error('Missing fixture state');
    const config = makeConfig();
    const prepared = prepareWorkflowExecution({
      ...ref,
      config,
      feature: saved.feature,
      resumeState: saved,
    });
    configStore.__testReset({ config, projectDir });
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref, feature: saved.feature }),
      execution: { kind: 'local', prepared },
    });
    const runWorkflow = vi.fn(() => new Promise<Summary>(() => {}));
    ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={() => {}} deps={{ runWorkflow }} />,
    );
    const screen = ui;
    await vi.waitFor(() => {
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Try again');
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Choose how to continue');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await flushEffects();
    screen.stdin.write('\t');
    await flushEffects();
    screen.stdin.write('Refactor');
    await flushEffects();
    screen.stdin.write(' ');
    await flushEffects();
    screen.stdin.write('src/auth.ts');
    await flushEffects();
    expect(stripAnsiStyles(screen.lastFrame())).toContain('Refactor src/auth.ts');
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(loadState(ref)?.pendingRecovery?.status).toBe('awaiting-user');

    screen.stdin.write('\r');
    await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalledOnce());
    const resumed = loadState(ref);
    expect(resumed?.pendingRecovery).toBeUndefined();
    expect(resumed?.messageQueue.map((message) => message.text)).toContain('Refactor src/auth.ts');
  });

  it.each(['menu', 'composer'])(
    'sends the note of Fix again from the %s after a failed final review',
    async (source) => {
      const note = 'Keep the total exact';
      const ref = { projectDir, sessionId: `recover-review-failed-${source}` };
      ensureSessionDir(projectDir, ref.sessionId);
      saveState(
        ref,
        makeWorkflowState({
          ...RUN_CREW,
          phase: 'final-review',
          pendingRecovery: makeRecoveryIssue({
            reason: 'review-failed',
            seat: 'build',
            phase: 'final-review',
            taskId: undefined,
            taskTitle: undefined,
            selectedImplementerProfile: undefined,
            files: [],
            affectedTaskIds: [],
            message: 'The final review found 1 blocking finding.',
            details: [],
            availableActions: ['revise', 'end-run'],
            recommendedAction: 'revise',
          }),
        }),
      );
      const saved = loadState(ref);
      if (saved === null) throw new Error('Missing fixture state');
      const config = makeConfig();
      const prepared = prepareWorkflowExecution({
        ...ref,
        config,
        feature: saved.feature,
        resumeState: saved,
      });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord({ ref, feature: saved.feature }),
        execution: { kind: 'local', prepared },
      });
      const runWorkflow = vi.fn(() => new Promise<Summary>(() => {}));
      ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={() => {}} deps={{ runWorkflow }} />,
      );
      const screen = ui;
      await vi.waitFor(() =>
        expect(stripAnsiStyles(screen.lastFrame())).toContain(
          'Fix again · add a note, grant one more fix cycle',
        ),
      );
      await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      await flushEffects();

      if (source === 'menu') {
        screen.stdin.write('v');
        await vi.waitFor(() =>
          expect(stripAnsiStyles(screen.lastFrame())).toContain('What should the fix change?'),
        );
        await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      } else {
        screen.stdin.write('\t');
      }
      await flushEffects();
      screen.stdin.write(note);
      await flushEffects();
      expect(stripAnsiStyles(screen.lastFrame())).toContain(note);
      expect(runWorkflow).not.toHaveBeenCalled();

      screen.stdin.write('\r');
      await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalledOnce());
      const resumed = loadState(ref);
      expect(resumed?.phase).toBe('final-review');
      expect(resumed?.pendingRecovery).toBeUndefined();
      expect(resumed?.pendingTriage?.inputs).toMatchObject([
        { kind: 'defect', source: 'user', text: note },
      ]);
      const replay = await readRunEvents(ref);
      expect(
        replay.events.flatMap((event) =>
          event.type === 'recovery_action_selected' ? [[event.reason, event.action]] : [],
        ),
      ).toEqual([['review-failed', 'revise']]);
    },
  );
});

describe('a sentence on the panel of an Apply halt', () => {
  async function openApplyPartialHalt(sessionId: string) {
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, ref.sessionId);
    saveState(
      ref,
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'worktree',
          path: `${projectDir}/wt`,
          base: { snapshotId: 'base', head: null },
        },
        pendingRecovery: buildApplyPartialRecoveryIssue({
          backupId: 'backup-1',
          backupDir: '.splitbrief/apply-backups/backup-1',
          createdAt: '2026-10-23T00:00:00.000Z',
          written: ['src/a.ts'],
          files: ['src/a.ts', 'src/b.ts'],
          failedFile: 'src/b.ts',
          cause: 'EACCES: permission denied',
        }),
      }),
    );
    const saved = loadState(ref);
    if (saved === null) throw new Error('Missing fixture state');
    const config = makeConfig();
    const prepared = prepareWorkflowExecution({
      ...ref,
      config,
      feature: saved.feature,
      resumeState: saved,
    });
    configStore.__testReset({ config, projectDir });
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref, feature: saved.feature }),
      execution: { kind: 'local', prepared },
    });
    const runWorkflow = vi.fn(() => new Promise<Summary>(() => {}));
    ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={() => {}} deps={{ runWorkflow }} />,
    );
    const screen = ui;
    await vi.waitFor(() => {
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Restore backup');
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Choose an action above');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await flushEffects();
    return { ref, screen, runWorkflow };
  }

  it('refuses the sentence and puts it back in the composer', async () => {
    const { ref, screen, runWorkflow } = await openApplyPartialHalt('apply-partial-sentence');

    screen.stdin.write('\t');
    await flushEffects();
    screen.stdin.write('mind the lockfile');
    await flushEffects();
    screen.stdin.write('\r');

    await vi.waitFor(() =>
      expect(stripAnsiStyles(screen.lastFrame())).toContain('This halt takes no typed correction'),
    );
    await vi.waitFor(() => expect(composerLiveStore.get().text).toBe('mind the lockfile'));
    expect(stripAnsiStyles(screen.lastFrame())).toContain('mind the lockfile');
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(loadState(ref)?.pendingRecovery?.status).toBe('awaiting-user');
  });

  it('refuses a sentence with an image and puts the image back in the composer', async () => {
    writeFileSync(
      join(projectDir, 'shot.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const { ref, screen, runWorkflow } = await openApplyPartialHalt('apply-partial-image');

    screen.stdin.write('\t');
    await flushEffects();
    screen.stdin.write('see @shot.png please');
    await flushEffects();
    screen.stdin.write('\r');

    await vi.waitFor(() =>
      expect(stripAnsiStyles(screen.lastFrame())).toContain('This halt takes no typed correction'),
    );
    await vi.waitFor(() =>
      expect(composerLiveStore.get().document.parts).toMatchObject([
        { kind: 'text', text: 'see ' },
        { kind: 'image', attachment: { path: expect.stringMatching(/shot\.png$/) } },
        { kind: 'text', text: ' please' },
      ]),
    );
    const texts = composerLiveStore
      .get()
      .document.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : []));
    expect(texts.some((text) => text.includes('[image:'))).toBe(false);
    expect(texts.some((text) => text.includes('Images referenced above'))).toBe(false);
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(loadState(ref)?.pendingRecovery?.status).toBe('awaiting-user');
  });

  it('runs Restore backup from u typed in the composer', async () => {
    const { ref, screen, runWorkflow } = await openApplyPartialHalt('apply-partial-key');

    screen.stdin.write('\t');
    await flushEffects();
    screen.stdin.write('u');
    await flushEffects();
    screen.stdin.write('\r');

    await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalledOnce());
    expect(stripAnsiStyles(screen.lastFrame())).not.toContain('Cannot send');
    expect(loadState(ref)?.pendingRecovery).toMatchObject({
      status: 'applying',
      selectedAction: 'restore-backup',
    });
  });
});
