import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readMessages } from '../../../src/core/sessions/log-reader.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { readInterruptedPartial } from '../../../src/engine/orchestrator/continuation.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { makeImplementerRetryInvoker } from '../../../src/engine/orchestrator/escalation/make-implementer-retry-invoker.js';
import { createImplementerBase } from '../../../src/engine/implementers/pipeline/run.js';
import { buildLanguageContext } from '../../../src/engine/spec/prompts/language-context.js';

const projects: string[] = [];

afterEach(() => {
  for (const project of projects) cleanupTempDir(project);
  projects.length = 0;
});

function setup() {
  const projectDir = createTempDir('continuation-residue');
  projects.push(projectDir);
  execFileSync('git', ['init', '-q', projectDir]);
  const workspaceDir = join(projectDir, 'isolated');
  mkdirSync(workspaceDir);
  const sessionId = 'sess-cut';
  const controller = new AbortController();
  const narration = 'The first edit is in progress.';
  const implementer = createImplementerBase(
    makeBaseConfig({
      extractsCode: false,
      invoke: async (call) => {
        call.onOutput(narration);
        controller.abort();
        return makeRunnerCallResult({
          status: 'aborted',
          text: narration,
          error: { code: 'user-abort', message: 'stopped' },
        });
      },
    }),
  );
  return {
    projectDir,
    workspaceDir,
    sessionId,
    controller,
    narration,
    implementer,
    task: makeTask(),
    config: makeConfig(),
  };
}

describe('a stopped production implementer call', () => {
  for (const kind of ['normal', 'local', 'consult'] as const) {
    it(`keeps ${kind} narration in the authoritative log for continuation`, async () => {
      const fixture = setup();
      const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
      if (kind === 'normal') {
        await fixture.implementer.implement({
          task: fixture.task,
          projectDir: fixture.workspaceDir,
          fileIgnoreProjectDir: fixture.projectDir,
          sessionId: fixture.sessionId,
          config: fixture.config,
          context: defaultContext,
          onOutput: () => {},
          signal: fixture.controller.signal,
          phase: 'implementing',
        });
      } else {
        const retry = makeImplementerRetryInvoker({
          context: defaultContext,
          kind,
          sessionId: fixture.sessionId,
          languageContext: buildLanguageContext('typescript'),
          phase: 'implementing',
        });
        await retry({
          task: fixture.task,
          lastError: 'validation failed',
          attempts: 1,
          projectDir: fixture.workspaceDir,
          fileIgnoreProjectDir: fixture.projectDir,
          config: fixture.config,
          implementer: fixture.implementer,
          signal: fixture.controller.signal,
          seat: {
            ref: { ...ref, bus: createEventBus() },
            state: createInitialState('continuation residue'),
            usageCategory: 'implementer',
          },
        });
      }

      expect(await readInterruptedPartial(ref)).toBe(fixture.narration);
      const messages = [];
      for await (const message of readMessages(ref)) messages.push(message);
      expect(messages).toEqual([
        expect.objectContaining({
          role: 'assistant',
          phase: 'implementing',
          text: fixture.narration,
          interrupted: true,
        }),
      ]);
      expect(
        existsSync(
          join(fixture.workspaceDir, '.splitbrief', 'sessions', fixture.sessionId, 'session.jsonl'),
        ),
      ).toBe(false);
      expect(existsSync(join(fixture.projectDir, '.git', 'index'))).toBe(false);
    });
  }
});
