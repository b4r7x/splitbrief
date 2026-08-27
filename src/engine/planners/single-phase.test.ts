import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { formatRepoMapBlock, prepareInvokeArgs, runSinglePhasePlanning } from './single-phase.js';
import type { PlannerCallbacks } from './types.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import {
  createTaskCompilationAttemptId,
  TaskCompilationSemanticIdSchema,
} from '../../core/schemas/task-compilation.js';

const taskMarkdown = `---
id: T001
title: Test task
action: create
file: src/example.ts
depends_on: []
---

### Description
Create an example file.

### Implementation Steps
1. Write the file.

### Tests
- vitest passes

### Constraints
- Follow project conventions
`;

const promptBuilder = (feature: string, projectContext: string, languageContext: LanguageContext) =>
  `FEATURE:${feature} LANG:${languageContext.language} CTX:${projectContext.length}`;

let projectDir: string;

function readSessionLog(projectDir: string, sessionId: string): unknown[] {
  const logPath = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function completedRunnerCall(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

beforeEach(() => {
  projectDir = createTempDir('single-phase-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('formatRepoMapBlock', () => {
  it('wraps non-empty context in a repo-map block', () => {
    expect(formatRepoMapBlock('files: a.ts')).toBe('<repo-map>\nfiles: a.ts\n</repo-map>\n\n');
  });

  it('returns empty string when context is undefined', () => {
    expect(formatRepoMapBlock(undefined)).toBe('');
  });
});

describe('prepareInvokeArgs', () => {
  it('prepends a CLI transcript prefix when prior messages exist and backend does not consume them', () => {
    const { effectivePrompt, extras } = prepareInvokeArgs({
      prompt: 'do the thing',
      priorMessages: [{ role: 'user', content: 'earlier turn' }],
      images: undefined,
      consumesPriorMessages: false,
    });
    expect(effectivePrompt).toContain('<!-- prior conversation -->');
    expect(effectivePrompt).toContain('[user] earlier turn');
    expect(effectivePrompt.endsWith('do the thing')).toBe(true);
    expect(extras.priorMessages).toBeUndefined();
  });

  it('forwards prior messages natively when the backend consumes them', () => {
    const { effectivePrompt, extras } = prepareInvokeArgs({
      prompt: 'do the thing',
      priorMessages: [{ role: 'user', content: 'earlier turn' }],
      images: undefined,
      consumesPriorMessages: true,
    });
    expect(effectivePrompt).toBe('do the thing');
    expect(extras.priorMessages).toEqual([{ role: 'user', content: 'earlier turn' }]);
  });
});

describe('runSinglePhasePlanning', () => {
  it('assembles repo-map + built prompt, buffers output, and returns a parsed PlanResult', async () => {
    let seenPrompt = '';
    const emittedPhases: string[] = [];
    const callbacks: PlannerCallbacks = {
      onOutput: () => {},
      onPhase: (phase) => emittedPhases.push(phase),
    };

    const result = await runSinglePhasePlanning(
      {
        invokePlan: async ({ prompt, callbacks: invokeCallbacks }) => {
          seenPrompt = prompt;
          invokeCallbacks.onOutput?.('streamed chunk');
          return completedRunnerCall(taskMarkdown);
        },
      },
      promptBuilder,
      {
        feature: 'add a widget',
        projectDir,
        callbacks,
        codebaseContext: 'files: a.ts',
      },
    );

    expect(seenPrompt.startsWith('<repo-map>\nfiles: a.ts\n</repo-map>\n\n')).toBe(true);
    expect(seenPrompt).toContain('FEATURE:add a widget');
    expect(emittedPhases).toEqual(['planning']);
    expect(result.spec).toBe('');
    expect(result.plan).toBe('');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T001');
    expect(result.phases).toHaveLength(1);
    expect(result.phases?.[0]?.artifact.logicalName).toBe('tasks.md');
    expect(result.phases?.[0]?.artifact.text).toBe(taskMarkdown);
    expect(result.phases?.[0]?.rawOutput).toBeUndefined();
  });

  it('omits the repo-map block from the prompt when no codebase context is supplied', async () => {
    let seenPrompt = '';

    await runSinglePhasePlanning(
      {
        invokePlan: async ({ prompt }) => {
          seenPrompt = prompt;
          return completedRunnerCall(taskMarkdown);
        },
      },
      promptBuilder,
      { feature: 'add a widget', projectDir, callbacks: { onOutput: () => {} } },
    );

    expect(seenPrompt).not.toContain('<repo-map>');
    expect(seenPrompt.startsWith('FEATURE:add a widget')).toBe(true);
  });

  it('flushes interrupted buffered output when planning aborts', async () => {
    const controller = new AbortController();
    const sessionId = 'sess-single-phase-abort';
    const err = new Error('aborted');

    await expect(
      runSinglePhasePlanning(
        {
          invokePlan: async ({ callbacks: invokeCallbacks }) => {
            invokeCallbacks.onOutput('partial task output');
            controller.abort();
            throw err;
          },
        },
        promptBuilder,
        {
          feature: 'add a widget',
          projectDir,
          callbacks: {
            onOutput: () => {},
            persistTranscript: true,
            sessionId,
            signal: controller.signal,
          },
        },
      ),
    ).rejects.toBe(err);

    expect(readSessionLog(projectDir, sessionId)).toEqual([
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        phase: 'planning',
        text: 'partial task output',
        interrupted: true,
      }),
    ]);
  });
});

describe('runSinglePhasePlanning — current-call ownership', () => {
  it('derives the phase from the completed current result and retains the receipt', async () => {
    const attemptIds: string[] = [];
    const result = await runSinglePhasePlanning(
      {
        invokePlan: async ({ callContext }) => {
          attemptIds.push(callContext.attemptId ?? '');
          return completedRunnerCall(taskMarkdown);
        },
      },
      promptBuilder,
      { feature: 'add a widget', projectDir, callbacks: { onOutput: () => {} } },
    );

    const phase = result.phases?.[0];
    expect(phase?.artifact.text).toBe(taskMarkdown);
    expect(phase?.artifact.attemptId).toBe(attemptIds[0]);
    expect(phase?.artifact.transport).toBe('stdout-final');
    expect(phase?.artifact.sourceReceipt).toMatchObject({ kind: 'stdout-final' });
  });

  it('rejects a failed call without phase bytes and stays single-call', async () => {
    let invokes = 0;
    await expect(
      runSinglePhasePlanning(
        {
          invokePlan: async () => {
            invokes += 1;
            return makeRunnerCallResult({
              status: 'failed',
              text: 'partial bytes',
              error: { code: 'provider', message: 'boom' },
            });
          },
        },
        promptBuilder,
        { feature: 'add a widget', projectDir, callbacks: { onOutput: () => {} } },
      ),
    ).rejects.toMatchObject({ kind: 'runner-call-failed' });
    expect(invokes).toBe(1);
  });

  it('ignores stale files on disk when deriving phase bytes', async () => {
    writeFileSync(join(projectDir, 'tasks.md'), 'stale disk bytes');
    const result = await runSinglePhasePlanning(
      { invokePlan: async () => completedRunnerCall(taskMarkdown) },
      promptBuilder,
      { feature: 'add a widget', projectDir, callbacks: { onOutput: () => {} } },
    );
    expect(result.phases?.[0]?.artifact.text).toBe(taskMarkdown);
  });

  it('rejects a declared-file receipt bound to a different attempt', async () => {
    const staleAttemptId = createTaskCompilationAttemptId();
    await expect(
      runSinglePhasePlanning(
        {
          invokePlan: async () => ({
            ...completedRunnerCall(taskMarkdown),
            transport: {
              kind: 'declared-file',
              lease: { leaseId: 'lease-1', relativePath: 'out/result' },
            },
            ownedArtifactReceipt: {
              semanticId: TaskCompilationSemanticIdSchema.parse('tasks-program'),
              programId: null,
              batchId: null,
              attemptId: staleAttemptId,
              leaseId: 'lease-1',
              relativePath: 'out/result',
              inodeIdentity: 'inode-1',
              ancestryDigest: 'ancestry-1',
              sha256: 'sha-1',
              byteLength: 10,
              leaseReceiptDigest: 'lease-digest',
            },
          }),
        },
        promptBuilder,
        { feature: 'add a widget', projectDir, callbacks: { onOutput: () => {} } },
      ),
    ).rejects.toMatchObject({ kind: 'custom-planner-artifact-invalid' });
  });
});
