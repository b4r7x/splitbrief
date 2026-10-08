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
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import type { Validator } from '../validation/types.js';
import type { EscalationContext } from './types.js';
import { validateAndCommit } from './validate-and-commit.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
      formatChangedFiles: vi.fn().mockImplementation(async () => {
        controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
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
      validationResults: [],
      acceptance: { accepted: false, exemptStages: [], blockingStages: [] },
    });
  });

  it('blocks a retry whose required brief check fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T013',
      suggestedFiles: ['src/blocks.ts'],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({
        command: 'tsc',
        code: 2,
        stderr: 'src/blocks.ts(1,1): error TS1005',
        output: '',
      }),
    );
    const validator: Validator = { formatChangedFiles: vi.fn().mockResolvedValue(undefined) };

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
      acceptance: { accepted: false, exemptStages: [], blockingStages: [] },
      diagnosis: 'check K1 failed',
    });
  });
});
