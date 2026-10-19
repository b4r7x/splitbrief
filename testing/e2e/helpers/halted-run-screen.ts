import { createElement } from 'react';
import { expect, vi } from 'vitest';
import { App, type AppProps } from '../../../src/app/root.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';
import type { RunWorkflowFn } from '../../../src/features/workflow/hooks/use-run-loop.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { flushSessionDrafts, saveSessionDraft } from '../../../src/stores/ui/session-drafts.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import type { StopContinueFixture } from './stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };

/**
 * An engine entry that stays open until the screen aborts it. The screen aborts at unmount, so
 * the run ends there and no later test meets its config subscriber.
 */
export function heldUntilAborted(signal: AbortSignal | undefined): Promise<Summary> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * Opens a run the CLI left halted in the App, on its workflow screen with its recovery menu up.
 * By default the preparation is a stand-in and each engine entry stays open until the screen
 * aborts it at unmount, so a test sees what the screen does before re-entry; a test that runs
 * the real engine passes both.
 */
export async function openHaltedRun(
  target: Pick<StopContinueFixture, 'projectDir' | 'stateHome'>,
  options: Readonly<{
    heading: string;
    draft?: string | undefined;
    runWorkflow?: RunWorkflowFn | undefined;
    prepare?:
      | ((input: Readonly<{ ref: SessionRef; state: WorkflowState }>) => Promise<PreparedExecution>)
      | undefined;
  }>,
) {
  vi.stubEnv('XDG_STATE_HOME', target.stateHome);
  const projectDir = await canonicalizeProjectDir({ project: target.projectDir });
  const sessionId = readActive(projectDir);
  if (sessionId === null) throw new Error('The halted run saved no session');
  const ref = { projectDir, sessionId };
  const state = loadState(ref);
  if (state === null) throw new Error('The halted run saved no state');
  if (options.draft !== undefined) {
    saveSessionDraft(ref, createDraftDocument(options.draft));
    flushSessionDrafts();
  }
  const record = readRunRecord(ref);
  const { config } = loadConfig(projectDir);
  configStore.load(projectDir);
  terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
  await hydrateRun(record);
  const prepared =
    options.prepare === undefined
      ? prepareWorkflowExecution({
          projectDir,
          sessionId,
          config,
          feature: state.feature,
          resumeState: state,
        })
      : await options.prepare({ ref, state });
  routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'local', prepared } });
  const runWorkflow = vi.fn<RunWorkflowFn>(
    options.runWorkflow ?? ((opts) => heldUntilAborted(opts.signal)),
  );
  const screen = renderFeature(
    createElement<AppProps>(App, { workflowDeps: { runWorkflow } }),
    VIEWPORT,
  );
  try {
    await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain(options.heading));
  } catch (err) {
    screen.unmount();
    throw err;
  }
  await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
  await flushEffects();
  return { screen, ref, state, runWorkflow };
}
