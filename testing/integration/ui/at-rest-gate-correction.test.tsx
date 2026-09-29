import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { SessionSelectDeps } from '../../../src/stores/navigation/session-select.js';
import { handleSessionSelect } from '../../../src/stores/navigation/session-select.js';
import { loadOwnerWorkflowState } from '../../../src/core/state/resume-hydration.js';
import { hydrateRun, readRunHistory } from '../../../src/features/workflow/run-history.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { makePassingTask } from '#testing/helpers/planning-phase.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { formatTasks } from '../../../src/engine/spec/formatter.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { sessionDir } from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

const STEER = 'prefer the cached parser, please';

let projectDir = '';
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  projectDir = createTempDir('at-rest-steer-screen');
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(projectDir);
});

describe('a correction typed at a parked approval gate', () => {
  it.each(['spec', 'briefs'] as const)(
    'revises %s before reopening its gate and replays one user message',
    async (gate) => {
      const sessionId = 'at-rest-steer-session';
      const feature = 'add auth';
      const tasks = [makePassingTask()];
      const phase = gate === 'spec' ? 'reviewing-spec' : 'reviewing-briefs';
      const savedState: WorkflowState = {
        ...createInitialState(feature),
        phase,
        tasks,
        mode: 'standard',
        approve: 'all',
        interruptedStep: {
          step: { kind: 'gate', gate },
          source: 'user',
          cut: 'boundary',
          at: new Date().toISOString(),
        },
      };
      ensureSessionDir(projectDir, sessionId);
      writeFileSync(
        join(sessionDir(projectDir, sessionId), 'spec.md'),
        '# Spec\n\nOriginal requirement.\n',
      );
      writeFileSync(join(sessionDir(projectDir, sessionId), 'tasks.md'), formatTasks(tasks));
      saveState({ projectDir, sessionId }, savedState);

      const steers: (string | undefined)[] = [];
      const prompts: string[] = [];
      const config = makeConfig({ workflow: { mode: 'standard', approve: 'all' } });
      const revised =
        gate === 'spec'
          ? `# Revised spec\n\n${STEER}\n`
          : formatTasks([
              { ...makePassingTask(), title: 'Use the cached parser', description: STEER },
            ]);
      const revise = async (prompt: string) => {
        prompts.push(prompt);
        return { text: revised, usage: null };
      };
      const planner = makePlanner({ regenerate: ({ prompt }) => revise(prompt), review: revise });
      const prepared = prepareWorkflowExecution({
        projectDir,
        feature,
        config,
        sessionId,
        resumeState: savedState,
      });
      const sessionSelect: SessionSelectDeps = {
        loadResumeState: loadOwnerWorkflowState,
        prepareResume: async () => ({ kind: 'prepared', execution: prepared }),
        hydrateRun,
        readRunHistory,
      };
      const deps: WorkflowScreenDeps = {
        runWorkflow: async (options) => {
          steers.push(options.steer);
          return runWorkflow({
            ...options,
            _planner: planner,
            callbacks: {
              ...options.callbacks,
              onApprovalNeeded: async () => ({ approved: false, action: 'end-run' }),
            },
          });
        },
        sessionSelect,
      };

      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
      await handleSessionSelect(
        makeSession({ id: sessionId, feature, status: 'open' }),
        projectDir,
        sessionSelect,
      );
      const entered = routerStore.get();
      expect(entered.screen === 'workflow' && entered.execution.kind).toBe('at-rest');

      ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={deps} />, {
        cols: 120,
        rows: 40,
      });
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain('gate');
      });
      expect(
        eventsStore.get().events.filter((event) => event.type === 'user_message'),
      ).toHaveLength(0);

      await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
      ui.stdin.write(STEER);
      await flushEffects();
      ui.stdin.write('\r');

      await vi.waitFor(() => {
        expect(steers.at(-1)).toBe(STEER);
        expect(
          eventsStore
            .get()
            .events.filter((event) => event.type === 'user_message')
            .map((event) => ('text' in event ? event.text : '')),
        ).toEqual([STEER]);
      });
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain(STEER);
      });
      await vi.waitFor(() => {
        const route = routerStore.get();
        expect(route.screen === 'workflow' && route.execution.kind === 'at-rest').toBe(true);
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(STEER);
      expect(
        readFileSync(
          join(sessionDir(projectDir, sessionId), gate === 'spec' ? 'spec.md' : 'tasks.md'),
          'utf8',
        ),
      ).toContain('cached parser');

      const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
      const steerRows = log
        .split('\n')
        .filter(
          (line) => line.includes('"kind":"message"') && line.includes(JSON.stringify(STEER)),
        );
      expect(steerRows).toHaveLength(1);

      const replay = await readRunEvents({ projectDir, sessionId });
      expect(
        replay.events
          .filter((event) => event.type === 'user_message')
          .map((event) => ('text' in event ? event.text : '')),
      ).toEqual([STEER]);
    },
  );
});
