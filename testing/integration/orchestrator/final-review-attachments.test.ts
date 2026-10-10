import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { createEvidenceLedger } from '../../../src/core/evidence/ledger-state.js';
import { writeSpecFile } from '../../../src/core/paths-io.js';
import { SPEC_FILE } from '../../../src/core/paths.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { runFinalReviewPhase } from '../../../src/engine/orchestrator/final-review.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe.each(['cli', 'api'] as const)('attached context in %s review', (kind) => {
  it.each(['task', 'final'] as const)(
    'keeps the saved attachment in a %s review',
    async (scope) => {
      const ref = setupGitSessionProject({
        prefix: 'review-attachments',
        sessionId: 'attachments',
      });
      dirs.push(ref.projectDir);
      const head = readFileSync(join(ref.projectDir, '.git/refs/heads/main'), 'utf8').trim();
      const task = makeTask({ id: 'T001', status: 'done', suggestedFiles: ['init.txt'] });
      const state = makeImplState([task], {
        plannerContext: '--- @/outside/notes.md ---\nREVIEW-ATTACHMENT-CONTEXT',
        changedFilesBaseline: { head, fingerprints: {}, runStartChangedFiles: [] },
      });
      writeSpecFile(ref, SPEC_FILE, 'Review the completed task.', null);
      writeEvidenceLedger(
        ref,
        createEvidenceLedger({ sessionId: ref.sessionId, feature: state.feature, tasks: [task] }),
      );
      const prompts: string[] = [];
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([task]),
          (prompt) => {
            prompts.push(prompt);
            return passingReviewVerdict(prompt);
          },
        ),
      });
      const config = makeNoValidationConfig({
        reviewer:
          kind === 'cli'
            ? { kind: 'cli', tool: 'codex' }
            : {
                kind: 'api',
                provider: 'ollama',
                apiBase: 'http://localhost:11434/v1',
                model: 'fixture',
                contextLength: 200_000,
              },
      });

      const result = await runFinalReviewPhase({
        ...ref,
        workspaceDir: ref.projectDir,
        config,
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        state,
        reviewer,
        scope,
        ...(scope === 'task' && { afterTaskId: task.id }),
      });

      expect(result.reviewStatus, JSON.stringify(result.failure)).toBe('written');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(`<user-context>\n${state.plannerContext}\n</user-context>`);
      expect(result.state.plannerContext).toBe(state.plannerContext);
    },
  );
});
