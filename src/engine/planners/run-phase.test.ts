import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { callPhase, phaseInputs } from '#testing/helpers/planner-call.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import { createPlannerBase } from './base.js';
import { runDocumentPhases } from './document-phases.js';
import type { PlannerCapabilities, PlannerDocumentCall } from './types.js';

let projectDir: string;

const capabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: false,
};

const taskMarkdown = `---
id: T001
title: Test task
action: create
file: src/example.py
depends_on: []
---

### Description
Create an example file.

### Implementation Steps
1. Write the file.

### Tests
- pytest passes

### Constraints
- Follow project conventions
`;

function completedRunnerCall(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

function recordingPlanner(outputs: string[] = []) {
  const prompts: string[] = [];
  const artifactFiles: Array<string | undefined> = [];
  const priorSeen: Array<ReadonlyArray<{ role: string; content: string }> | undefined> = [];
  const planner = createPlannerBase({
    invokePlan: async ({ prompt, artifactFile, priorMessages }) => {
      prompts.push(prompt);
      artifactFiles.push(artifactFile);
      priorSeen.push(priorMessages);
      return completedRunnerCall(outputs[prompts.length - 1] ?? taskMarkdown);
    },
    invokeEscalate: async () => completedRunnerCall(''),
    isAvailable: async () => true,
    capabilities,
  });
  return { planner, prompts, artifactFiles, priorSeen };
}

function readSessionLog(dir: string, sessionId: string): unknown[] {
  const logPath = join(sessionDir(dir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  projectDir = createTempDir('planner-run-phase');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('runPhase — one call per phase', () => {
  it('spends exactly one backend call and owns one artifact', async () => {
    const { planner, prompts, artifactFiles } = recordingPlanner(['# Research\n\nFindings.']);

    const result = await callPhase(planner, {
      call: 'research',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    expect(prompts).toHaveLength(1);
    expect(artifactFiles).toEqual(['research.md']);
    expect(result.artifact.artifact.logicalName).toBe('research.md');
    expect(result.artifact.artifact.text).toBe('# Research\n\nFindings.');
    expect(result.artifact.rawOutput).toBeUndefined();
    expect(result.tasks).toBeUndefined();
  });

  it('builds the prompt of the call it was asked for', async () => {
    const cases: Array<[PlannerDocumentCall, string]> = [
      ['research', 'Research Task'],
      ['spec', 'Write Feature Specification'],
      ['plan', 'Write Implementation Plan'],
      ['tasks', 'Compile Product Task Briefs'],
    ];
    for (const [call, title] of cases) {
      const { planner, prompts } = recordingPlanner(['# Heading\n\nbody']);
      await callPhase(planner, {
        call,
        projectDir,
        callbacks: { onOutput: () => {} },
        quickPlan: undefined,
      });
      expect(prompts[0], call).toContain(title);
    }
  });

  it('the tasks call with quick inputs uses the quick prompt', async () => {
    const { planner, prompts } = recordingPlanner([taskMarkdown]);
    await callPhase(planner, { projectDir, callbacks: { onOutput: () => {} } });
    expect(prompts[0]).toContain('Quick: Compile Task Briefs');
  });

  it('parses Task Briefs on the tasks call only', async () => {
    const { planner } = recordingPlanner([taskMarkdown, taskMarkdown]);
    const tasks = await callPhase(planner, { projectDir, callbacks: { onOutput: () => {} } });
    expect(tasks.tasks?.map((task) => task.id)).toEqual(['T001']);

    const { planner: other } = recordingPlanner([taskMarkdown]);
    const plan = await callPhase(other, {
      call: 'plan',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(plan.tasks).toBeUndefined();
  });

  it('leads the prompt with the caller-supplied prefix', async () => {
    const { planner, prompts } = recordingPlanner(['# Research\n\nFindings.']);
    await planner.runPhase({
      call: 'research',
      projectDir,
      callbacks: { onOutput: () => {} },
      inputs: phaseInputs({ promptPrefix: 'QUEUED MESSAGE\n\n' }),
    });
    expect(prompts[0]?.startsWith('QUEUED MESSAGE')).toBe(true);
  });

  it('trails the prompt with the caller-supplied suffix', async () => {
    const { planner, prompts } = recordingPlanner(['# Research\n\nFindings.']);
    await planner.runPhase({
      call: 'research',
      projectDir,
      callbacks: { onOutput: () => {} },
      inputs: phaseInputs({ promptSuffix: '[Continuation] the note' }),
    });
    expect(prompts[0]?.endsWith('[Continuation] the note')).toBe(true);
    // The step's own prompt is still there; the suffix is a note on the end.
    expect(prompts[0]?.length).toBeGreaterThan('[Continuation] the note'.length);
  });

  it('sends the continuation turn alone when the seat already holds the step prompt', async () => {
    const { planner, prompts } = recordingPlanner(['# Research\n\nFindings.']);
    await planner.runPhase({
      call: 'research',
      projectDir,
      callbacks: { onOutput: () => {} },
      inputs: phaseInputs({
        promptPrefix: 'QUEUED MESSAGE\n\n',
        continuationTurn: '[Continuation] You were interrupted.',
      }),
    });
    expect(prompts[0]).toBe('QUEUED MESSAGE\n\n[Continuation] You were interrupted.');
  });

  it('refuses a spec or plan artifact that is not Markdown', async () => {
    const { planner } = recordingPlanner(['']);
    await expect(
      callPhase(planner, {
        call: 'spec',
        projectDir,
        callbacks: { onOutput: () => {} },
        quickPlan: undefined,
      }),
    ).rejects.toMatchObject({
      kind: 'planning-invalid-artifact',
      data: { phase: 'specifying', filename: 'spec.md' },
    });
  });

  it('flushes interrupted buffered output when the call aborts', async () => {
    const controller = new AbortController();
    const sessionId = 'sess-run-phase-abort';
    const err = new Error('aborted');
    const planner = createPlannerBase({
      invokePlan: async ({ callbacks }) => {
        callbacks.onOutput('partial research output');
        controller.abort();
        throw err;
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities,
    });

    await expect(
      callPhase(planner, {
        call: 'research',
        projectDir,
        callbacks: { onOutput: () => {}, sessionId, signal: controller.signal },
      }),
    ).rejects.toBe(err);

    expect(readSessionLog(projectDir, sessionId)).toEqual([
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        phase: 'researching',
        text: 'partial research output',
        interrupted: true,
      }),
    ]);
  });
});

describe('runPhase — prior messages and attachments', () => {
  it('prepends the prior conversation to the first call of the planner only', async () => {
    const { planner, prompts } = recordingPlanner(['# Research\n\nFindings.', '# Spec\n\nBody.']);
    const priorMessages = [
      { role: 'user' as const, content: 'first turn' },
      { role: 'assistant' as const, content: 'first answer' },
    ];

    await callPhase(planner, {
      call: 'research',
      projectDir,
      priorMessages,
      callbacks: { onOutput: () => {} },
    });
    await callPhase(planner, {
      call: 'spec',
      projectDir,
      priorMessages,
      callbacks: { onOutput: () => {} },
    });

    expect(prompts[0]).toContain('<!-- prior conversation -->');
    expect(prompts[0]).toContain('[user] first turn');
    expect(prompts[0]).toContain('[assistant] first answer');
    expect(prompts[1]).not.toContain('<!-- prior conversation -->');
  });

  it('hands prior messages to the backend untouched when it consumes them natively', async () => {
    let seen: ReadonlyArray<{ role: string; content: string }> | undefined;
    const prompts: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt, priorMessages }) => {
        prompts.push(prompt);
        if (priorMessages) seen = priorMessages;
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities,
      consumesPriorMessages: true,
    });

    await callPhase(planner, {
      projectDir,
      priorMessages: [{ role: 'user', content: 'raw turn' }],
      callbacks: { onOutput: () => {} },
    });

    expect(prompts[0]).not.toContain('<!-- prior conversation -->');
    expect(seen).toEqual([{ role: 'user', content: 'raw turn' }]);
  });
});

describe('runDocumentPhases', () => {
  it('runs one call per document step and returns every artifact', async () => {
    const { planner, prompts, artifactFiles } = recordingPlanner([
      '# Research\n\nFindings.',
      '# Spec\n\nRequirements.',
      '# Plan\n\nSteps.',
      taskMarkdown,
    ]);

    const result = await runDocumentPhases({
      planner,
      mode: 'standard',
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    expect(prompts).toHaveLength(4);
    expect(artifactFiles).toEqual(['research.md', 'spec.md', 'plan.md', 'tasks.md']);
    expect(result.phases).toHaveLength(4);
    expect(result.spec).toBe('# Spec\n\nRequirements.');
    expect(result.plan).toBe('# Plan\n\nSteps.');
    expect(result.tasks.map((task) => task.id)).toEqual(['T001']);
  });

  it('feeds the language the research call discovered into the later prompts', async () => {
    const { planner, prompts } = recordingPlanner([
      `## Validation Tools

- **Language**: python
- **Type checker**: \`mypy src/\`
- **Linter**: \`ruff check\`
- **Test runner**: \`pytest\`
- **Test file pattern**: \`test_*.py\``,
      '# Spec',
      '# Plan',
      taskMarkdown,
    ]);

    await runDocumentPhases({
      planner,
      mode: 'standard',
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    expect(prompts[2]).toContain('Python');
    expect(prompts[2]).not.toContain('TypeScript');
    expect(prompts[3]).toContain('file: src/path/to/file.py');
  });

  it('quick mode spends one call and reads the project for its language', async () => {
    writeFileSync(join(projectDir, 'pyproject.toml'), '[tool.pytest.ini_options]');
    const { planner, prompts } = recordingPlanner([taskMarkdown]);

    await runDocumentPhases({
      planner,
      mode: 'quick',
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Python');
    expect(prompts[0]).toContain('file: src/path/to/file.py');
    expect(prompts[0]).not.toMatch(/TypeScript|```typescript|file\.ts/);
  });

  it('forwards skillsContext into the prompt it builds', async () => {
    const { planner, prompts } = recordingPlanner([taskMarkdown]);
    await runDocumentPhases({
      planner,
      mode: 'quick',
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
      skillsContext: '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY',
    });
    expect(prompts[0]).toContain('## Active Project Skills');
    expect(prompts[0]).toContain('SKILL-BODY');
  });
});
