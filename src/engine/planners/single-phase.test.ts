import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { formatRepoMapBlock, prepareInvokeArgs, runSinglePhasePlanning } from './single-phase.js';
import type { PlannerCallbacks } from './types.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';

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
          return { text: taskMarkdown, usage: null };
        },
      },
      promptBuilder,
      'add a widget',
      projectDir,
      callbacks,
      'files: a.ts',
    );

    expect(seenPrompt.startsWith('<repo-map>\nfiles: a.ts\n</repo-map>\n\n')).toBe(true);
    expect(seenPrompt).toContain('FEATURE:add a widget');
    expect(emittedPhases).toEqual(['planning']);
    expect(result.spec).toBe('');
    expect(result.plan).toBe('');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T001');
    expect(result.phases).toHaveLength(1);
    expect(result.phases?.[0]?.filename).toBe('tasks.md');
    expect(result.phases?.[0]?.text).toBe(taskMarkdown);
    expect(result.phases?.[0]?.rawOutput).toBeUndefined();
  });

  it('resolves the artifact via readPhaseOutput and retains raw stdout separately', async () => {
    const result = await runSinglePhasePlanning(
      {
        invokePlan: async () => ({ text: 'raw stdout noise', usage: null }),
        readPhaseOutput: () => taskMarkdown,
      },
      promptBuilder,
      'add a widget',
      projectDir,
      { onOutput: () => {} },
      undefined,
    );

    expect(result.phases?.[0]?.text).toBe(taskMarkdown);
    expect(result.phases?.[0]?.rawOutput).toBe('raw stdout noise');
    expect(result.tasks[0]?.id).toBe('T001');
  });
});
