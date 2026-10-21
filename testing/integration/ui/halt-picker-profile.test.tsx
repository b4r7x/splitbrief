import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { PINNED_CLAUDE_CODE_OPTIONS } from '#testing/helpers/factories/model-cache.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ToolModelPicker } from '../../../src/app/overlays/runners.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { switchSeatAndPrepareResume } from '../../../src/engine/orchestrator/recovery/switch-seat-resume.js';
import { createRecoveryDriver } from '../../../src/features/workflow/recovery-driver.js';
import { addTuiEvent } from '../../../src/features/workflow/tui-sink.js';
import type { UseInputModeResult } from '../../../src/features/workflow/hooks/use-input-mode.js';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache/state.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { pickerViewStore } from '../../../src/stores/ui/picker-view.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

const BIG = { kind: 'cli', tool: 'claude-code', model: 'sonnet', contextLength: 200_000 } as const;
const SMALL = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } as const;

const dirs: string[] = [];
const mounted: Array<() => void> = [];

function answerSwitchSeat(): UseInputModeResult {
  return {
    mode: 'question',
    hint: '',
    questionEpoch: 0,
    setReviewMode: async () => ({ approved: false }),
    setQuestionMode: async () => plainUserMessage('switch-seat'),
    resolve: () => {},
    resetMode: () => {},
  };
}

/** A run whose routed `small` BUILD profile hit a usage limit; `big` is the default profile. */
function writeHaltedOnSmallProfile() {
  const projectDir = createTempDir('halt-picker-profile');
  dirs.push(projectDir);
  const ref = { projectDir, sessionId: 'sess-profile' };
  ensureSessionDir(projectDir, ref.sessionId);
  const config = makeConfig({
    implementer: BIG,
    implementerProfiles: {
      default: 'big',
      profiles: { big: { ...BIG, label: 'Big' }, small: { ...SMALL, label: 'Small' } },
    },
  });
  writeConfig(projectDir, config);
  configStore.load(projectDir);
  const task = makeTask({ id: 'T001', status: 'failed' });
  saveState(
    ref,
    makeImplState([task], {
      pendingRecovery: makeRecoveryIssue({
        reason: 'runner-usage-limit',
        taskId: task.id,
        availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
        recommendedAction: 'switch-seat',
        selectedImplementerProfile: 'small',
        switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
      }),
    }),
  );
  const state = loadState(ref);
  if (state === null) throw new Error('expected the halted state to persist');
  return { ref, state };
}

function haltedOnSmallProfile() {
  const { ref, state } = writeHaltedOnSmallProfile();
  const projectDir = ref.projectDir;
  const sourceConfig = loadConfig(projectDir).config;
  const prepared = makePreparedExecution({
    ...ref,
    feature: state.feature,
    config: sourceConfig,
    resumeState: state,
    active: reactivateExistingSession(ref),
  });
  const pending = createRecoveryDriver({
    prepared,
    configOfRun: sourceConfig,
    inputMode: answerSwitchSeat(),
    abortedRef: { current: false },
    retentionNoticeHandled: { current: false },
    sink: addTuiEvent,
    setInlineResume: () => {},
  })({ state, controller: new AbortController(), republishPrompt: false });
  return { ref, state, sourceConfig, pending };
}

describe('the halt picker of a named BUILD profile', () => {
  beforeEach(() => {
    resetAllStores();
    modelCacheStore.__testSetClaudeCodeModelOptions(PINNED_CLAUDE_CODE_OPTIONS);
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    });
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.();
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
    resetAllStores();
  });

  it('moves the halted profile to the typed custom model and leaves the default profile as it was', async () => {
    const { ref, state, sourceConfig, pending } = haltedOnSmallProfile();
    await vi.waitFor(() => {
      expect(overlayStore.get()).toMatchObject({
        active: 'implementer-picker',
        focus: 'tool:claude-code',
      });
    });
    pickerViewStore.open({ kind: 'custom-model' });
    const ui = renderFeature(<ToolModelPicker slot="seat" role="implementer" />);
    mounted.push(ui.unmount);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Model id for Claude Code CLI');
    ui.stdin.write('my-a');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    const result = await pending;
    if (!result.shouldRun || result.switchSeat === undefined) {
      throw new Error('expected the halt picker to hand back a seat switch');
    }
    expect(result.switchSeat.candidate).toMatchObject({ tool: 'claude-code', model: 'my-a' });

    const switched = await switchSeatAndPrepareResume({
      ...ref,
      state,
      config: sourceConfig,
      candidate: result.switchSeat.candidate,
      bus: createRecoveryBus({ ...ref, sink: () => {} }),
      signal: new AbortController().signal,
      policy: result.switchSeat.policy,
      prepare: async (input) => ({
        kind: 'prepared',
        execution: makePreparedExecution({
          ...ref,
          feature: state.feature,
          config: input.effectiveConfig,
          purpose: 'resume',
        }),
      }),
    });

    expect(switched.kind).toBe('switched');
    const profiles = loadConfig(ref.projectDir).config.implementerProfiles;
    expect(profiles?.default).toBe('big');
    expect(profiles?.profiles.big).toEqual({ ...BIG, label: 'Big' });
    expect(profiles?.profiles.small).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'my-a',
      customModels: ['my-a'],
      label: 'Small',
    });
  });

  it('saves the BUILD seat to the halted profile while the halted run is open at rest', async () => {
    const { ref, state } = writeHaltedOnSmallProfile();
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        ref,
        hydration: { kind: 'loaded', state },
        status: deriveRunStatus({ state, liveness: 'not-alive' }),
      }),
      execution: { kind: 'at-rest' },
    });
    overlayStore.open('implementer-picker', 'tool:claude-code');
    pickerViewStore.open({ kind: 'custom-model' });
    const ui = renderFeature(<ToolModelPicker slot="seat" role="implementer" />);
    mounted.push(ui.unmount);
    await flushEffects();
    ui.stdin.write('my-a');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(loadConfig(ref.projectDir).config.implementerProfiles?.profiles.small).toMatchObject({
        tool: 'claude-code',
        model: 'my-a',
      });
    });
    expect(loadConfig(ref.projectDir).config.implementerProfiles?.profiles.big).toEqual({
      ...BIG,
      label: 'Big',
    });
  });
});
