import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { SessionSelectDeps } from '../../../src/stores/navigation/session-select.js';
import { handleSessionSelect } from '../../../src/stores/navigation/session-select.js';
import { loadOwnerWorkflowState } from '../../../src/core/state/resume-hydration.js';
import { hydrateRun, readRunHistory } from '../../../src/features/workflow/run-history.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import type { RecoveryIssue } from '../../../src/core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { useInputMode } from '../../../src/features/workflow/hooks/use-input-mode.js';
import {
  useRunContinue,
  type UseRunContinueResult,
} from '../../../src/features/workflow/hooks/use-run-continue.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';

const WORDS = 'mind the lockfile';
const VIEWPORT = { cols: 120, rows: 40 } as const;

let projectDir = '';
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  projectDir = createTempDir('at-rest-halt-typed-words');
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(projectDir);
});

function haltedState(
  issue: Partial<RecoveryIssue>,
  workspace: 'checkout' | 'worktree',
): WorkflowState {
  return {
    ...createInitialState('add a word counter'),
    ...RUN_CREW,
    phase: 'complete',
    reviewStatus: 'failed',
    workspace: {
      kind: workspace,
      path: workspace === 'checkout' ? projectDir : `${projectDir}/wt`,
      base: { snapshotId: 'base', head: null },
    },
    pendingRecovery: makeRecoveryIssue({
      taskId: undefined,
      affectedTaskIds: [],
      phase: 'complete',
      ...issue,
    }),
  };
}

/** A failed review an older build saved half answered: Accept as is chosen, not yet applied. */
const OLDER_ACCEPT: Partial<RecoveryIssue> = {
  reason: 'review-failed',
  seat: 'review',
  availableActions: ['revise', 'accept-as-is', 'end-run'],
  recommendedAction: 'revise',
  status: 'applying',
  selectedAction: 'accept-as-is',
};

describe('words typed on a run at rest for a chosen action that reads none', () => {
  it.each(['checkout', 'worktree'] as const)(
    'refuses them in %s mode, keeps them in the composer, and saves and records nothing',
    async (workspace) => {
      const sessionId = `older-accept-${workspace}`;
      const ref = { projectDir, sessionId };
      const saved = haltedState(OLDER_ACCEPT, workspace);
      saveState(ref, saved);
      const before = loadState(ref);
      const config = makeConfig();
      const runWorkflow = vi.fn();
      const prepareResume = vi.fn();
      const sessionSelect: SessionSelectDeps = {
        applying: () => false,
        loadResumeState: loadOwnerWorkflowState,
        prepareResume,
        hydrateRun,
        readRunHistory,
      };
      const deps: WorkflowScreenDeps = { runWorkflow, sessionSelect };
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
      await handleSessionSelect(
        makeSession({ id: sessionId, feature: saved.feature, status: 'open' }),
        projectDir,
        sessionSelect,
      );

      ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={deps} />,
        VIEWPORT,
      );
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain('Needs you');
      });
      await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      ui.stdin.write(WORDS);
      await flushEffects();
      ui.stdin.write('\r');

      await vi.waitFor(() => {
        expect(feedbackStore.get()).toEqual({
          message: 'Cannot send words with Accept as is. Clear them.',
          isError: true,
        });
      });
      await vi.waitFor(() => {
        expect(composerLiveStore.get().text).toBe(WORDS);
      });
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(WORDS);
      expect(prepareResume).not.toHaveBeenCalled();
      expect(runWorkflow).not.toHaveBeenCalled();
      expect(loadState(ref)).toEqual(before);
      expect(eventsStore.get().events.some((event) => event.type === 'user_message')).toBe(false);
      const route = routerStore.get();
      expect(route.screen === 'workflow' && route.execution.kind).toBe('at-rest');
    },
  );

  it('keeps the transcript when a stopped run this screen drove refuses them', async () => {
    const sessionId = 'apply-partial-local';
    const ref = { projectDir, sessionId };
    const saved = haltedState(
      {
        reason: 'apply-partial',
        availableActions: ['retry-same-worker', 'restore-backup'],
        recommendedAction: 'retry-same-worker',
      },
      'worktree',
    );
    saveState(ref, saved);
    const config = makeConfig();
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature: saved.feature,
      resumeState: saved,
      config,
    });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref }),
      execution: { kind: 'local', prepared },
    });
    createRecoveryBus({ ...ref, sink: addEvent }).publish({
      type: 'workflow_started',
      ts: 1_000,
      phase: 'planning',
      feature: saved.feature,
    });
    let continuation: UseRunContinueResult | undefined;
    function Harness({ prepared }: { prepared: PreparedExecution }) {
      continuation = useRunContinue({ prepared, inputMode: useInputMode() });
      return <Text>harness</Text>;
    }
    ui = renderFeature(<Harness prepared={prepared} />, VIEWPORT);
    const document = createDraftDocument(WORDS);
    composerLiveStore.setDraft(document);

    continuation?.handleResume(plainUserMessage(WORDS));

    expect(feedbackStore.get()).toEqual({
      message: 'Cannot send words to this halt. Clear them first.',
      isError: true,
    });
    expect(composerDraftStore.get().request).toMatchObject({ kind: 'prepend', value: WORDS });
    expect(eventsStore.get().events.map((event) => event.type)).toContain('workflow_started');
    expect(continuation?.runId).toBe(0);
    expect(loadState(ref)).toEqual(saved);
  });
});
