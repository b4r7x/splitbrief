import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlannerBase } from './base.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import type { PlannerCapabilities } from './types.js';
import type { RunnerCallEvent } from '../calls/types.js';

let projectDir: string;

const minimalTask = makeTask();

const defaultCapabilities: PlannerCapabilities = {
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
  projectDir = createTempDir('planner-base-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createPlannerBase — phase artifact content', () => {
  it('phases[].text contains resolved artifact when readPhaseOutput is provided', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall('raw stdout noise'),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      readPhaseOutput: (_filename, _resultText, _projectDir) => '# Resolved artifact content',
    });

    const result = await planner.plan({
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    for (const phase of result.phases ?? []) {
      expect(phase.text).toBe('# Resolved artifact content');
      expect(phase.rawOutput).toBe('raw stdout noise');
    }
  });

  it('phases[].text equals stdout when no readPhaseOutput hook is provided', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall('# Direct stdout content'),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.plan({
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    for (const phase of result.phases ?? []) {
      expect(phase.text).toBe('# Direct stdout content');
      expect(phase.rawOutput).toBeUndefined();
    }
  });

  it('quickPlan phases[].text contains resolved artifact from readPhaseOutput', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall('raw quick output'),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      readPhaseOutput: (_filename, _resultText, _projectDir) => `---
id: T001
title: Test task
action: create
file: test.ts
---

### Description
A test task.

### Tests
- pass

### Constraints
- none
`,
    });

    const result = await planner.quickPlan({
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.phases).toHaveLength(1);
    expect(result.phases![0]!.text).toContain('id: T001');
    expect(result.phases![0]!.rawOutput).toBe('raw quick output');
  });

  it('standard planning uses research-discovered language for later prompts', async () => {
    const captured: string[] = [];
    const outputs = [
      `## Validation Tools

- **Language**: python
- **Type checker**: \`mypy src/\`
- **Linter**: \`ruff check\`
- **Test runner**: \`pytest\`
- **Test file pattern**: \`test_*.py\``,
      '# Spec',
      '# Plan',
      taskMarkdown,
    ];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        captured.push(prompt);
        return completedRunnerCall(outputs[captured.length - 1] ?? '');
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.plan({ feature: 'feature', projectDir, callbacks: { onOutput: () => {} } });

    expect(captured[2]).toContain('Python');
    expect(captured[2]).toContain('PEP 484');
    expect(captured[2]).not.toContain('TypeScript');
    expect(captured[3]).toContain('file: src/path/to/file.py');
    expect(captured[3]).not.toContain('```typescript');
  });

  it('quickPlan uses prompt-language heuristic when no research phase exists', async () => {
    writeFileSync(join(projectDir, 'pyproject.toml'), '[tool.pytest.ini_options]');
    let captured = '';
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        captured = prompt;
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.quickPlan({ feature: 'feature', projectDir, callbacks: { onOutput: () => {} } });

    expect(captured).toContain('Python');
    expect(captured).toContain('file: src/path/to/file.py');
    expect(captured).not.toMatch(/TypeScript|```typescript|file\.ts/);
  });

  it('flushes interrupted buffered output when a standard planner phase aborts', async () => {
    const controller = new AbortController();
    const sessionId = 'sess-planner-base-abort';
    const err = new Error('aborted');
    const planner = createPlannerBase({
      invokePlan: async ({ callbacks }) => {
        callbacks.onOutput('partial research output');
        controller.abort();
        throw err;
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await expect(
      planner.plan({
        feature: 'feature',
        projectDir,
        callbacks: {
          onOutput: () => {},
          persistTranscript: true,
          sessionId,
          signal: controller.signal,
        },
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

describe('createPlannerBase — hintSuccessMode', () => {
  it('hintSuccessMode: "files" — succeeds when files are written', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => {
        writeFileSync(outFile, '// written by escalation');
        return completedRunnerCall('');
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — fails when no files are written', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "text" (default) — succeeds when text is non-empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall('some hint output'),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "text" (default) — fails when text is empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('capabilities.supportsHintEscalation: false — always returns success: false', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall('lots of output'),
      isAvailable: async () => true,
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "files" — ignores pre-existing dirty files (before/after snapshot)', async () => {
    // A file is dirty BEFORE escalation runs
    const preExisting = join(projectDir, 'pre-existing.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    // Escalation writes a NEW file only
    const newFile = join(projectDir, 'new-from-hint.ts');
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => {
        writeFileSync(newFile, '// written by hint');
        return completedRunnerCall('');
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    // The new file is what triggered success — pre-existing dirty file is baseline, not a signal
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — not success when only pre-existing dirty files remain', async () => {
    // A file is dirty BEFORE escalation AND escalation writes nothing new
    const preExisting = join(projectDir, 'pre-existing-only.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });
});

describe('createPlannerBase — structured summarization', () => {
  it('validates structured summary JSON from the planner', async () => {
    const structured = {
      goal: 'add compaction',
      stepsCompleted: ['wrote schema'],
      currentStep: 'testing',
      filesModified: ['src/core/schemas/compaction.ts'],
      constraintsDiscovered: ['return JSON only'],
      remainingWork: ['run tests'],
    };
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(JSON.stringify(structured)),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.summarizeStructured?.([{ role: 'user', text: 'compact this' }], {
      projectDir,
    });

    expect(result).toEqual({ text: JSON.stringify(structured), structured, usage: null });
  });

  it('uses the merge prompt when a previous structured summary is provided', async () => {
    const previous = {
      goal: 'add compaction',
      stepsCompleted: ['old step'],
      currentStep: 'old current',
      filesModified: ['old.ts'],
      constraintsDiscovered: ['old constraint'],
      remainingWork: ['old work'],
    };
    let prompt = '';
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async (opts) => {
        prompt = opts.prompt;
        return completedRunnerCall(JSON.stringify(previous));
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.summarizeStructured?.([{ role: 'assistant', text: 'new work' }], {
      previousSummary: previous,
      projectDir,
    });

    expect(prompt).toContain('Previous summary:');
    expect(prompt).toContain(JSON.stringify(previous));
    expect(prompt).toContain('New messages:');
  });

  it('passes signal and runner-call callbacks to structured summary invocations', async () => {
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];
    const structured = {
      goal: 'add compaction',
      stepsCompleted: ['old step'],
      currentStep: 'testing',
      filesModified: ['src/core/schemas/compaction.ts'],
      constraintsDiscovered: ['return JSON only'],
      remainingWork: ['run tests'],
    };
    let capturedSignal: AbortSignal | undefined;
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async (opts) => {
        capturedSignal = opts.signal;
        opts.callbacks.onCallEvent?.({ type: 'call_started', ts: Date.now(), ...opts.callContext });
        return completedRunnerCall(JSON.stringify(structured));
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.summarizeStructured?.([{ role: 'user', text: 'compact this' }], {
      projectDir,
      signal: controller.signal,
      callbacks: { onCallEvent: (event) => events.push(event) },
      role: 'compaction',
    });

    expect(capturedSignal).toBe(controller.signal);
    expect(events[0]).toMatchObject({
      type: 'call_started',
      role: 'compaction',
      backendKind: 'cli',
    });
  });
});

describe('createPlannerBase — priorMessages injection (FR-007)', () => {
  it('prepends a <!-- prior conversation --> block to the first phase prompt for CLI-style backends', async () => {
    const captured: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        captured.push(prompt);
        return completedRunnerCall('ok');
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.plan({
      feature: 'feature',
      projectDir,
      callbacks: {
        onOutput: () => {},
        priorMessages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'first answer' },
        ],
      },
    });

    // First phase (research) gets the prefix
    expect(captured[0]).toContain('<!-- prior conversation -->');
    expect(captured[0]).toContain('[user] first turn');
    expect(captured[0]).toContain('[assistant] first answer');
    expect(captured[0]).toContain('<!-- /prior conversation -->');
    // Subsequent phases do NOT repeat the prefix
    expect(captured[1]).not.toContain('<!-- prior conversation -->');
    expect(captured[2]).not.toContain('<!-- prior conversation -->');
    expect(captured[3]).not.toContain('<!-- prior conversation -->');
  });

  it('does NOT prepend CLI prefix when consumesPriorMessages is true', async () => {
    let seenPriorMessages: ReadonlyArray<{ role: string; content: string }> | undefined;
    const captured: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt, priorMessages }) => {
        captured.push(prompt);
        if (priorMessages) seenPriorMessages = priorMessages;
        return completedRunnerCall('ok');
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      consumesPriorMessages: true,
    });

    await planner.plan({
      feature: 'feature',
      projectDir,
      callbacks: {
        onOutput: () => {},
        priorMessages: [{ role: 'user', content: 'raw turn' }],
      },
    });

    expect(captured[0]).not.toContain('<!-- prior conversation -->');
    expect(seenPriorMessages).toEqual([{ role: 'user', content: 'raw turn' }]);
  });
});
