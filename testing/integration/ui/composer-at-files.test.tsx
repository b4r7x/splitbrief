import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { renderDockedComposer } from '#testing/helpers/composer.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { mountWorkflowScreen, prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { HomeScreen } from '../../../src/app/screens/home.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { sessionSelectDeps } from '../../../src/app/prepare-resume.js';
import type { DraftSubmission } from '../../../src/core/composer/submission.js';
import { readSessionLog } from '../../../src/core/sessions/log-reader.js';
import type { SessionLogEntry } from '../../../src/core/schemas/session-log.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { inputHistoryStore } from '../../../src/stores/ui/input-history.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { attachmentsStore } from '../../../src/stores/workflow/attachments.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';

describe('composer @ files', () => {
  let projectDir = '';
  let outsideDir = '';
  let ui: ReturnType<typeof renderFeature> | undefined;
  let running: Promise<Summary> | undefined;

  function engine(script: Parameters<typeof scriptedTypedCall>[0]) {
    const { typedCall, prompts } = scriptedTypedCall(script);
    const planner = makePlanner({ typedCall });
    return {
      prompts,
      deps: {
        runWorkflow: (options: RunWorkflowOptions) => {
          running = runWorkflow({ ...options, _planner: planner, _implementer: makeImplementer() });
          return running;
        },
      },
    };
  }

  async function expectPublished(displayText: string, path: string) {
    const attachedInputs = [{ path: realpathSync(path), kind: 'text' }];
    const messages = eventsStore.get().events.filter((event) => event.type === 'user_message');
    const matching = messages.filter((event) => event.text === displayText);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ text: displayText, attachedInputs });
    expect(messages.every((event) => !event.text.includes('PELICAN-42'))).toBe(true);

    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('No workflow route');
    const entries: SessionLogEntry[] = [];
    for await (const entry of readSessionLog(route.run.ref)) entries.push(entry);
    const logs = entries
      .filter((entry) => entry.kind === 'message')
      .filter((entry) => entry.role === 'user' && entry.text === displayText);
    expect(logs).toHaveLength(1);
    const events = entries
      .filter((entry) => entry.kind === 'event')
      .filter((entry) => entry.type === 'user_message');
    const event = events.filter((entry) => {
      const data = entry.data;
      return (
        typeof data === 'object' && data !== null && 'text' in data && data.text === displayText
      );
    });
    expect(event).toHaveLength(1);
    const [log] = logs;
    const [loggedEvent] = event;
    if (log === undefined || loggedEvent === undefined) throw new Error('No user message log pair');
    expect(loggedEvent.data).toMatchObject({ text: displayText, attachedInputs });
    expect(entries.indexOf(loggedEvent)).toBe(entries.indexOf(log) + 1);
    expect(log.text).not.toContain('PELICAN-42');
    const replayed = await readRunEvents(route.run.ref);
    expect(
      replayed.events.filter(
        (event) => event.type === 'user_message' && event.text === displayText,
      ),
    ).toHaveLength(1);
  }

  beforeEach(() => {
    resetAllStores();
    routerStore.init({ screen: 'home' });
    projectDir = createTempDir('composer-at-project');
    outsideDir = createTempDir('composer-at-outside');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  afterEach(async () => {
    ui?.unmount();
    ui = undefined;
    await running;
    running = undefined;
    resetAllStores();
    cleanupTempDir(projectDir);
    cleanupTempDir(outsideDir);
  });

  it('sends an outside home file to the planner and publishes one compact event and log pair', async () => {
    const path = join(outsideDir, 'brief.md');
    const content = 'PELICAN-42\nKeep @references in this body unchanged.\n';
    writeFileSync(path, content);
    const { prompts, deps } = engine([makePlanProposal()]);
    ui = renderFeature(
      <HomeScreen
        commands={[]}
        onRuntimeCommand={() => {}}
        deps={{
          sessionSelect: sessionSelectDeps,
          prepareExecution: async (input) => {
            const prepared = prepareWorkflowExecution({
              projectDir,
              feature: input.feature,
              config: input.effectiveConfig,
            });
            return {
              kind: 'prepared',
              execution: {
                ...prepared,
                runtime: {
                  ...prepared.runtime,
                  plannerContext: input.plannerContext,
                  attachedInputs: input.attachedInputs,
                },
              },
            };
          },
        }}
      />,
      { cols: 120, rows: 40 },
    );
    try {
      await flushEffects();
      ui.stdin.write(`@${path} hello`);
      await flushEffects();
      ui.stdin.write('\r');
      await flushEffects();

      await vi.waitFor(() => expect(routerStore.get().screen).toBe('workflow'));
      ui.rerender(<WorkflowScreen commands={[]} onRuntimeCommand={() => {}} deps={deps} />);
      await vi.waitFor(() => expect(reviewStore.get().source).not.toBeNull(), { timeout: 5000 });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(`--- @${path} ---\n${content}`);
      expect(eventsStore.get().events.find((event) => event.type === 'user_message')).toMatchObject(
        {
          text: `@${path} hello`,
          attachedInputs: [{ path: realpathSync(path), kind: 'text' }],
        },
      );
      await expectPublished(`@${path} hello`, path);
    } finally {
      ui.unmount();
    }
  });

  it('sends an outside file answer to the next planner turn and publishes it once', async () => {
    const path = join(outsideDir, 'answer.md');
    writeFileSync(path, 'PELICAN-42');
    const question = 'Which brief should guide the plan?';
    const { prompts, deps } = engine([
      {
        kind: 'questions',
        questions: [{ id: 'brief', text: question, choices: null, default: 'Please use' }],
      },
      makePlanProposal(),
    ]);
    ui = mountWorkflowScreen({ deps, projectDir, rows: 40 });
    await vi.waitFor(
      () => expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain('Question 1 of 1'),
      { timeout: 5000 },
    );
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    // The second row under the default opens an empty field for an answer of one's own.
    ui.stdin.write('\u001b[B');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write(`Please use @${path}`);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(reviewStore.get().source).not.toBeNull(), { timeout: 5000 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`--- @${path} ---\nPELICAN-42`);
    await expectPublished(`1. ${question}\nPlease use @${path}`, path);
  });

  it('sends an outside file in plan feedback to the revision turn and publishes it once', async () => {
    const path = join(outsideDir, 'revision.md');
    writeFileSync(path, 'PELICAN-42');
    const { prompts, deps } = engine([makePlanProposal(), makePlanProposal()]);
    ui = mountWorkflowScreen({ deps, projectDir, rows: 40 });
    await vi.waitFor(
      () => expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain('Type a comment…'),
      { timeout: 5000 },
    );
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    ui.stdin.write(`@${path}`);
    await flushEffects();
    await vi.waitFor(() => expect(composerLiveStore.get().text).toBe(`@${path}`));
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(() => expect(reviewStore.get().source).not.toBeNull(), { timeout: 5000 });
    expect(prompts[1]).toContain(`--- @${path} ---\nPELICAN-42`);
    await expectPublished(`@${path}`, path);
  });

  it('refuses an outside directory without changing the draft, history, or pending images', async () => {
    const submissions: Extract<DraftSubmission, { ok: true }>[] = [];
    attachmentsStore.add({
      id: 'pending-image',
      kind: 'image',
      path: join(outsideDir, 'pending.png'),
      mimeType: 'image/png',
      sizeBytes: 1,
    });
    const pendingImages = attachmentsStore.peek();
    const history = inputHistoryStore.get();
    const draft = `@${outsideDir}/ hello`;
    const ui = renderDockedComposer({
      commands: [],
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: '',
      width: 120,
      onSubmit: (submission) => submissions.push(submission),
      onRuntimeCommand: () => {},
    });
    try {
      await flushEffects();
      ui.stdin.write(draft);
      await flushEffects();
      ui.stdin.write('\r');
      await flushEffects();

      expect(submissions).toEqual([]);
      expect(composerLiveStore.get().text).toBe(draft);
      expect(inputHistoryStore.get()).toEqual(history);
      expect(attachmentsStore.peek()).toEqual(pendingImages);
      expect(feedbackStore.get().message).toContain(
        'Cannot send: not a regular file. Name a file, not a directory.',
      );
      expect(ui.lastFrame()).toContain('Cannot send: not a regular file.');
      expect(ui.lastFrame()).toContain('Name a file, not a directory.');
    } finally {
      ui.unmount();
    }
  });
});
