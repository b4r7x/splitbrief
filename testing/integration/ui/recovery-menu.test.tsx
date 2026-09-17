import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { configStore } from '../../../src/stores/project/config.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

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
  it.each(['pause', 'correction'] as const)(
    'keeps spaces in the draft, then applies the %s in its focused control',
    async (action) => {
      const ref = { projectDir, sessionId: 'recover-planning' };
      ensureSessionDir(projectDir, ref.sessionId);
      saveState(
        ref,
        makeWorkflowState({
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
            availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
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

      if (action === 'pause') {
        screen.stdin.write('\t');
        await flushEffects();
        screen.stdin.write(' ');
        await vi.waitFor(() => expect(loadState(ref)?.pendingRecovery?.status).toBe('paused'));
        expect(runWorkflow).not.toHaveBeenCalled();
      } else {
        screen.stdin.write('\r');
        await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalledOnce());
        const resumed = loadState(ref);
        expect(resumed?.pendingRecovery).toBeUndefined();
        expect(resumed?.messageQueue.map((message) => message.text)).toContain(
          'Refactor src/auth.ts',
        );
      }
    },
  );
});
