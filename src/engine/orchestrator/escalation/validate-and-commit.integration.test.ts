import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../core/schemas/config.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { Validator } from '../validation/types.js';
import type { EscalationContext } from './types.js';
import { validateAndCommit } from './validate-and-commit.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('validate-commit-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-validate-commit';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function configWithProfiles(): Config {
  return {
    ...makeNoValidationConfig({
      approval: { feedRejectionsToPlanner: true },
      workflow: { review: 'task' },
      validation: { test: true },
    }),
    implementerProfiles: {
      default: 'local-small',
      profiles: {
        'local-small': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen-small',
          contextLength: 8_192,
        },
      },
    },
  };
}

async function makeValidateCtx(opts: {
  projectDir: string;
  sessionId: string;
  validator: Validator;
  signal?: AbortSignal | undefined;
}): Promise<EscalationContext> {
  return {
    taskStartTime: Date.now(),
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      config: configWithProfiles(),
      validator: opts.validator,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
    taskStartSnapshot: await getChangedFilesSnapshot(opts.projectDir),
    dependsOnFiles: [],
  };
}

describe('validateAndCommit', () => {
  it('does not commit retry results when the signal aborts during validation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T011', suggestedFiles: ['src/abort.ts'] });
    const controller = new AbortController();
    const validator: Validator = {
      formatChangedFiles: vi.fn().mockResolvedValue(undefined),
      runFullSuite: vi.fn().mockResolvedValue({ results: [], newFailures: {} }),
      runValidation: vi.fn().mockImplementation(async () => {
        controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
        return [{ stage: 'test' as const, passed: true }];
      }),
    };

    const result = await validateAndCommit({
      ctx: await makeValidateCtx({
        projectDir,
        sessionId,
        validator,
        signal: controller.signal,
      }),
      task,
      state: makeImplState([task]),
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result).toMatchObject({
      completed: false,
      blockedReason: 'aborted',
      validationResults: [{ stage: 'test', passed: true }],
      acceptance: { accepted: false, exemptStages: [], blockingStages: [] },
    });
  });

  it('accepts a retry whose only failing stage was pre-existing, like the task path', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T012', suggestedFiles: ['src/exempt.ts'] });
    const validator: Validator = {
      formatChangedFiles: vi.fn().mockResolvedValue(undefined),
      runFullSuite: vi.fn().mockResolvedValue({ results: [], newFailures: {} }),
      runValidation: vi.fn().mockResolvedValue([
        {
          stage: 'test' as const,
          passed: false,
          failureFiles: ['src/unrelated.ts'],
          preExisting: ['test failed without diagnostics'],
        },
      ]),
    };

    const result = await validateAndCommit({
      ctx: await makeValidateCtx({ projectDir, sessionId, validator }),
      task,
      state: makeImplState([task]),
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result).toMatchObject({
      completed: true,
      acceptance: { accepted: true, exemptStages: ['test'], blockingStages: [] },
    });
  });

  it('blocks a retry whose failing stage has no pre-existing attribution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T013', suggestedFiles: ['src/blocks.ts'] });
    const validator: Validator = {
      formatChangedFiles: vi.fn().mockResolvedValue(undefined),
      runFullSuite: vi.fn().mockResolvedValue({ results: [], newFailures: {} }),
      runValidation: vi
        .fn()
        .mockResolvedValue([
          { stage: 'test' as const, passed: false, failureFiles: ['src/blocking.ts'] },
        ]),
    };

    const result = await validateAndCommit({
      ctx: await makeValidateCtx({ projectDir, sessionId, validator }),
      task,
      state: makeImplState([task]),
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result).toMatchObject({
      completed: false,
      acceptance: { accepted: false, exemptStages: [], blockingStages: ['test'] },
    });
  });
});
