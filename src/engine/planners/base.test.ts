import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlannerBase } from './base.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeBusRecorder,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { runPlanningPhase } from '../orchestrator/planning/run.js';
import { createInitialState } from '../../core/state/machine.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { PlannerCapabilities } from './types.js';

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
      invokePlan: async () => ({ text: 'raw stdout noise', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
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
      invokePlan: async () => ({ text: '# Direct stdout content', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
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
      invokePlan: async () => ({ text: 'raw quick output', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
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

  it('instantPlan emits the instant-planning phase', async () => {
    const onPhase = () => {};
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });
    const instantPlan = planner.instantPlan;
    if (!instantPlan) throw new Error('Expected instantPlan to be implemented');

    const result = await instantPlan({
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {}, onPhase },
    });

    expect(result.tasks).toBeDefined();
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
        return { text: outputs[captured.length - 1] ?? '', usage: null };
      },
      invokeEscalate: async () => ({ text: '', usage: null }),
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
        return { text: taskMarkdown, usage: null };
      },
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.quickPlan({ feature: 'feature', projectDir, callbacks: { onOutput: () => {} } });

    expect(captured).toContain('Python');
    expect(captured).toContain('file: src/path/to/file.py');
    expect(captured).not.toMatch(/TypeScript|```typescript|file\.ts/);
  });
});

describe('createPlannerBase — hintSuccessMode', () => {
  it('hintSuccessMode: "files" — succeeds when files are written', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => {
        writeFileSync(outFile, '// written by escalation');
        return { text: '', usage: null };
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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: 'some hint output', usage: null }),
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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: 'lots of output', usage: null }),
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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => {
        writeFileSync(newFile, '// written by hint');
        return { text: '', usage: null };
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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: JSON.stringify(structured), usage: null }),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.summarizeStructured?.(
      [{ role: 'user', text: 'compact this' }],
      undefined,
      projectDir,
    );

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
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async (opts) => {
        prompt = opts.prompt;
        return { text: JSON.stringify(previous), usage: null };
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.summarizeStructured?.(
      [{ role: 'assistant', text: 'new work' }],
      previous,
      projectDir,
    );

    expect(prompt).toContain('Previous summary:');
    expect(prompt).toContain(JSON.stringify(previous));
    expect(prompt).toContain('New messages:');
  });
});

describe('createPlannerBase — priorMessages injection (FR-007)', () => {
  it('prepends a <!-- prior conversation --> block to the first phase prompt for CLI-style backends', async () => {
    const captured: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        captured.push(prompt);
        return { text: 'ok', usage: null };
      },
      invokeEscalate: async () => ({ text: '', usage: null }),
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
        return { text: 'ok', usage: null };
      },
      invokeEscalate: async () => ({ text: '', usage: null }),
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

describe('createPlannerBase — attachments capability gate (F-123 seam)', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  const attachment: Attachment = {
    id: 'att-1',
    kind: 'image',
    path: '/tmp/screenshot.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
  };

  async function runInstantWithAttachment(supportsImages: boolean) {
    const { projectDir, sessionId } = setupProject(dirs);
    let seenImages: Attachment[] | undefined;
    const planner = createPlannerBase({
      invokePlan: async ({ images }) => {
        seenImages = images;
        return { text: 'raw stdout noise', usage: null };
      },
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      capabilities: { ...defaultCapabilities, supportsImages },
      readPhaseOutput: () => REAL_TASKS_MD,
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const initial = createInitialState('add a login form from this mockup');
    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config: makeConfig({ workflow: { mode: 'instant' } }),
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        drainPendingAttachments: () => [attachment],
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'add a login form from this mockup',
    });
    return { result, events, getSeenImages: () => seenImages };
  }

  it('supportsImages false → emits planner_attachments_dropped and strips before the backend call', async () => {
    const { result, events, getSeenImages } = await runInstantWithAttachment(false);

    expect(result.cancelled).toBe(false);
    const dropped = events.find((e) => e.type === 'planner_attachments_dropped');
    expect(dropped).toBeDefined();
    expect(dropped && 'count' in dropped ? dropped.count : 0).toBe(1);
    expect(dropped && 'reason' in dropped ? dropped.reason : null).toBe('unsupported-backend');
    expect(getSeenImages()).toBeUndefined();
  });

  it('supportsImages true → forwards attachments verbatim to the backend, no drop event', async () => {
    const { result, events, getSeenImages } = await runInstantWithAttachment(true);

    expect(result.cancelled).toBe(false);
    expect(events.find((e) => e.type === 'planner_attachments_dropped')).toBeUndefined();
    expect(getSeenImages()).toEqual([attachment]);
  });
});

describe('createPlannerBase — unknown Task Brief section warning (F-429 / N399)', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  const tasksWithUnknownSection = `${REAL_TASKS_MD}
### Future Considerations

- this heading is outside the canonical grammar and will be dropped
`;

  it('emits a warning event when planner-generated briefs contain an unknown ### section', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: 'raw stdout noise', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      readPhaseOutput: () => tasksWithUnknownSection,
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const initial = createInitialState('add auth');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config: makeConfig({ workflow: { mode: 'instant' } }),
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        drainPendingAttachments: () => [],
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'add auth',
    });

    expect(result.cancelled).toBe(false);
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.includes('Future Considerations'),
    );
    expect(warning).toBeDefined();
  });
});
