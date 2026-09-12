import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  setupCommitProject,
} from '#testing/helpers/orchestrator-commit.js';
import { validateCommitAndAdvance } from './commit.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';

const acceptedAcceptance: ValidationAcceptance = {
  accepted: true,
  exemptStages: [],
  blockingStages: [],
};

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('commit-hooks-trust-home');
});

afterEach(() => {
  cleanupCommitTestProjects();
  trustHome.restore();
});

describe('validateCommitAndAdvance — commit hooks', () => {
  it('stages only the attributed set before the pre_commit hook, leaving unrelated dirty files unstaged', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const taskFile = firstCommitTask(state).file;
    mkdirSync(dirname(join(projectDir, taskFile)), { recursive: true });
    writeFileSync(join(projectDir, taskFile), 'task output');
    writeFileSync(join(projectDir, 'extra-a.txt'), 'a');
    writeFileSync(join(projectDir, 'extra-b.txt'), 'b');
    const sentinel = join(projectDir, 'hook-seen.json');
    writeFileSync(
      join(projectDir, 'capture-hook.mjs'),
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import { execSync } from 'node:child_process';",
        "const { context } = JSON.parse(readFileSync(0, 'utf-8'));",
        "const staged = execSync('git diff --cached --name-only', { cwd: context.projectDir, encoding: 'utf-8' })",
        "  .split('\\n').filter(Boolean);",
        `writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({ files: context.files ?? [], staged }));`,
      ].join('\n'),
    );
    const hooks: HooksConfig = {
      pre_commit: [
        {
          kind: 'command',
          command: 'node',
          args: ['capture-hook.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' } },
        hooks,
      }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [taskFile],
    });

    expect(result.completed).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    const seen = JSON.parse(readFileSync(sentinel, 'utf-8')) as {
      files: string[];
      staged: string[];
    };
    expect(seen.files).toEqual([taskFile]);
    expect(seen.staged).toEqual([taskFile]);
    expect(seen.staged).not.toContain('extra-a.txt');
    expect(seen.staged).not.toContain('extra-b.txt');
  });
});
