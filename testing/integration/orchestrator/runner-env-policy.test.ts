import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  CODE_RESPONSE,
  makeShellRunnerConfig,
  shellPlannerArgs,
} from '#testing/helpers/faux/shell-runner.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

const PLANTED_ENV = {
  SPLITBRIEF_FAKE_API_KEY: 'fake-api-key',
  SPLITBRIEF_FAKE_TOKEN: 'fake-token',
  CLAUDE_CODE_SESSION_ID: 'fake-session',
  CLAUDE_CODE_MESSAGING_TOKEN: 'fake-messaging-token',
  SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
  SPLITBRIEF_DECLARED_TOKEN: 'fake-declared',
};
const SECRET_SHAPED = /KEY|TOKEN|SECRET|PASSWORD|SSH_AUTH_SOCK|^CLAUDE_CODE_/;

const dirs: string[] = [];
const originalEnv = Object.fromEntries(
  Object.keys(PLANTED_ENV).map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  resetAllStores();
  Object.assign(process.env, PLANTED_ENV);
});
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

function recordEnvNames(capture: string): string {
  return `require('node:fs').appendFileSync(${JSON.stringify(capture)}, Object.keys(process.env).join('\\n') + '\\n');`;
}

function capturedNames(capture: string): string[] {
  expect(existsSync(capture)).toBe(true);
  return [...new Set(readFileSync(capture, 'utf8').split('\n').filter(Boolean))];
}

describe('runner environment policy', { timeout: 90_000 }, () => {
  it('keeps host credentials and the parent session out of the planner and the shell implementer', async () => {
    const projectDir = createTempDir('orch-int-env-policy');
    const captureDir = createTempDir('orch-int-env-policy-capture');
    dirs.push(projectDir, captureDir);
    createTestGitRepo(projectDir);
    const planner = join(captureDir, 'planner.txt');
    const implementer = join(captureDir, 'implementer.txt');

    const plannerArgs = shellPlannerArgs();
    const config = makeShellRunnerConfig({
      planner: {
        kind: 'shell',
        command: process.execPath,
        args: [plannerArgs[0] as string, `${recordEnvNames(planner)}\n${plannerArgs[1]}`],
      },
      implementer: {
        kind: 'shell',
        command: process.execPath,
        args: [
          '-e',
          `${recordEnvNames(implementer)} process.stdout.write(${JSON.stringify(CODE_RESPONSE)});`,
        ],
        env: ['SPLITBRIEF_DECLARED_TOKEN'],
        model: 'fake-model',
      },
    });
    const sessionId = 'env-policy-session';
    const preparationId = 'env-policy-preparation';
    const resumeState = persistReadyExecutionState(
      { projectDir, sessionId },
      {
        ...createInitialState('add hello'),
        phase: 'implementing',
        mode: 'quick',
        plannerTool: 'shell',
        implementerTool: 'shell',
        tasks: [
          makeTask({
            scope: {
              inBounds: ['src/hello.ts'],
              outOfBounds: ['Do not touch anything outside the task file.'],
            },
            evidence: ['brief-quality.json confirms the task brief is complete'],
            typeDefs: 'type HelloModule = { greeting: string }',
          }),
        ],
      },
    );
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature: 'add hello',
      config,
      preparationId,
      active: {
        version: 1 as const,
        sessionId,
        generation: '4a444444-4444-4444-8444-444444444444',
      },
      resumeState,
      purpose: 'resume',
      allowHooks: true,
      gates: () => [
        {
          kind: 'shell',
          slot: { role: 'planner' },
          preparationId,
          command: { kind: 'validated-config' },
        },
        {
          kind: 'shell',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          command: { kind: 'validated-config' },
        },
      ],
    });
    const recorded: EngineEvent[] = [];

    await runWorkflow({
      prepared,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _eventSink: (event) => recorded.push(event),
    });

    expect(recorded.map((event) => event.type)).toContain('workflow_complete');
    expect(capturedNames(planner).filter((name) => SECRET_SHAPED.test(name))).toEqual([]);
    expect(capturedNames(implementer).filter((name) => SECRET_SHAPED.test(name))).toEqual([
      'SPLITBRIEF_DECLARED_TOKEN',
    ]);
  });
});
