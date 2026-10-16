import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { checkFailureText } from '../../../src/engine/orchestrator/validation/failure-text.js';
import { runChecks } from '../../../src/engine/orchestrator/validation/run-checks.js';
import { parsePreparedConfig } from '../../../src/engine/runners/prepared-execution.js';
import {
  defaultContext,
  makeConfig,
  makeNoValidationConfig,
} from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir, withTempDir } from '#testing/helpers/temp-dir.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';
import {
  createLivePathsProject,
  disposeLivePathsProject,
  hiddenRetryCheckConfig,
  SLUGIFY_FIXTURE,
  withHiddenRetryCheck,
} from './live-paths.js';

const COMPLETE_SOURCE = [
  'export function shout(text) {',
  "  return text.toUpperCase() + '!';",
  '}',
  '',
  'export function slugify(text) {',
  "  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
  '}',
  '',
].join('\n');

/** The first output's tests; one already holds the title the hidden check would ask for first. */
const FIRST_TESTS = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { shout, slugify } from '../src/text.mjs';",
  '',
  "test('shout upper-cases and adds an exclamation mark', () => {",
  "  assert.equal(shout('hi'), 'HI!');",
  '});',
  '',
  "test('slugify trims hyphens', () => {",
  "  assert.equal(slugify('  Hello, World!  '), 'hello-world');",
  '});',
  '',
  "test('slugify passes the retry acceptance', () => {",
  "  assert.equal(slugify('a--b'), 'a-b');",
  '});',
  '',
].join('\n');

function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
}

/** What a builder that follows the hidden check's feedback adds: the test case it names. */
function acceptanceCase(error: string): string {
  const title = /named exactly "([^"]+)"/.exec(error)?.[1];
  if (title === undefined) throw new Error(`the retry feedback names no test case:\n${error}`);
  return [
    `test(${JSON.stringify(title)}, () => {`,
    "  assert.equal(slugify('Retry Acceptance'), 'retry-acceptance');",
    '});',
    '',
  ].join('\n');
}

describe('hidden retry acceptance', () => {
  it.each(['complete', 'broken suite', 'narrowed', 'deleted'])(
    'forces retry after a %s first output',
    async (firstOutput) => {
      await withTempDir('hidden-retry-check', async (root) => {
        const projectDir = join(root, 'project');
        const checkFile = join(root, 'hidden acceptance.mjs');
        const testFile = join(projectDir, 'test/text.test.mjs');
        writeFiles(projectDir, SLUGIFY_FIXTURE.files);
        const hidden = withHiddenRetryCheck(
          makeImplementer({
            implement: async ({ task }) => {
              expect(task.checks).toBeUndefined();
              expect(existsSync(checkFile)).toBe(false);
              writeFiles(projectDir, {
                'src/text.mjs':
                  firstOutput === 'broken suite'
                    ? COMPLETE_SOURCE.replace(".replace(/^-+|-+$/g, '')", '')
                    : COMPLETE_SOURCE,
                'test/text.test.mjs': FIRST_TESTS,
              });
              if (firstOutput === 'narrowed') {
                writeFiles(projectDir, {
                  'test/other.test.mjs': '',
                  'package.json': JSON.stringify({
                    type: 'module',
                    scripts: { test: 'node --test test/other.test.mjs' },
                  }),
                });
              }
              expect(spawnSync('npm', ['test'], { cwd: projectDir }).status).toBe(
                firstOutput === 'broken suite' ? 1 : 0,
              );
              if (firstOutput === 'deleted') unlinkSync(testFile);
              return { success: true, output: 'Implemented' };
            },
            retry: async ({ error }) => {
              expect(error).toContain(
                firstOutput === 'deleted'
                  ? 'named exactly "slugify passes the retry acceptance"'
                  : 'named exactly "slugify passes the retry acceptance again"',
              );
              writeFiles(projectDir, {
                'src/text.mjs': COMPLETE_SOURCE,
                'test/text.test.mjs': `${FIRST_TESTS}${acceptanceCase(error)}`,
              });
              return { success: true, output: 'Fixed' };
            },
          }),
          checkFile,
        );
        const task = makeTask({ suggestedFiles: ['src/text.mjs', 'test/text.test.mjs'] });
        // Frozen as a run's prepared config is, so a write to it from the hidden check throws here.
        const config = parsePreparedConfig(hiddenRetryCheckConfig(makeConfig(), checkFile));
        const options = {
          task,
          projectDir,
          config,
          context: { ...defaultContext, dir: projectDir },
          onOutput: () => {},
        };
        const checkOptions = {
          task,
          projectDir,
          config,
          bus: createEventBus(),
          phase: 'implementing' as const,
          npmScriptsApproved: false,
        };
        await hidden.implementer.implement(options);
        const [failed] = await runChecks(['hidden-retry-acceptance'], checkOptions);
        if (failed?.status !== 'fail') throw new Error('The hidden check must fail attempt one');
        const error = checkFailureText(failed);
        expect(error).toContain('Hidden acceptance check:');
        if (firstOutput === 'broken suite') {
          expect(error).toContain('The project test suite must pass.');
          expect(error).toContain('slugify trims hyphens');
        }
        await hidden.implementer.retry({ ...options, error, attempt: 1, kind: 'local' });
        expect(hidden.feedback).toEqual([error]);
        const [passed] = await runChecks(['hidden-retry-acceptance'], checkOptions);
        expect(passed?.status).toBe('pass');
      });
    },
  );
});

describe('hidden retry acceptance in a run', { timeout: 90_000 }, () => {
  const dirs: string[] = [];

  beforeEach(() => {
    resetAllStores();
  });

  afterEach(async () => {
    await settleTrackedWorkflows();
    while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
  });

  it('fails the first brief on the frozen prepared config, feeds the retry, and reaches ready-to-apply', async () => {
    const root = createTempDir('hidden-retry-run');
    dirs.push(root);
    const projectDir = join(root, 'project');
    createTestGitRepo(projectDir, SLUGIFY_FIXTURE.files);
    const checkFile = join(root, 'hidden-acceptance.mjs');
    const sessionId = 'sess-hidden-retry-acceptance';
    const events: EngineEvent[] = [];
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      title: 'Add slugify',
      description: SLUGIFY_FIXTURE.feature,
      suggestedFiles: ['src/text.mjs', 'test/text.test.mjs'],
      tests: [],
      checks: [{ id: 'T001-K1', kind: 'cmd', value: 'node --version', required: false }],
    });
    const hidden = withHiddenRetryCheck(
      makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: async (opts) => {
          writeFiles(opts.projectDir, {
            'src/text.mjs': COMPLETE_SOURCE,
            'test/text.test.mjs': FIRST_TESTS,
          });
          return { success: true, output: 'Implemented' };
        },
        retry: async (opts) => {
          writeFiles(opts.projectDir, {
            'test/text.test.mjs': `${FIRST_TESTS}${acceptanceCase(opts.error)}`,
          });
          return { success: true, output: 'Fixed' };
        },
      }),
      checkFile,
    );
    const config = hiddenRetryCheckConfig(
      makeNoValidationConfig({
        implementer: {
          kind: 'agent',
          command: 'node',
          model: 'cheap-direct-agent',
          contextLength: 4096,
        },
        workflow: { approve: 'none', review: 'task' },
      }),
      checkFile,
    );

    await runTrackedWorkflow({
      prepared: makePreparedExecution({
        projectDir,
        sessionId,
        feature: SLUGIFY_FIXTURE.feature,
        config,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: makePlanner({ typedCall: typedCallFromTasks([task]) }),
      _implementer: hidden.implementer,
      _eventSink: (event) => events.push(event),
    });

    const retry = events.find(
      (event): event is Extract<EngineEvent, { type: 'task_retry' }> => event.type === 'task_retry',
    );
    expect(retry?.error).toContain('Hidden acceptance check:');
    expect(hidden.feedback).toEqual([retry?.error]);
    const state = loadState({ projectDir, sessionId });
    if (state === null) throw new Error('the run saved no state');
    expect(deriveRunStatus({ state, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
  });
});

describe('disposing a live project', () => {
  it.each([true, false])(
    'keeps the project only when the scenario failed (%s) and restores the state home',
    async (failed) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stateHome = process.env.XDG_STATE_HOME;
      const project = createLivePathsProject({
        id: 'dispose',
        fixture: SLUGIFY_FIXTURE,
        crew: {
          plan: { tool: 'claude-code', model: 'sonnet' },
          build: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
          review: { tool: 'claude-code', model: 'sonnet' },
        },
      });
      try {
        expect(process.env.XDG_STATE_HOME).toBe(project.stateHome);
        await disposeLivePathsProject(project, failed);
        expect(process.env.XDG_STATE_HOME).toBe(stateHome);
        expect(existsSync(project.projectDir)).toBe(failed);
        expect(log.mock.calls.flat().join('\n').includes(project.tmpDir)).toBe(failed);
      } finally {
        project.restoreStateHome();
        project.stopWatchingRunners();
        log.mockRestore();
        cleanupTempDir(project.tmpDir);
      }
    },
  );
});
