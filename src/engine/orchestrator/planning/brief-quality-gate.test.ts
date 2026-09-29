import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runBriefQualityGate,
  runBriefQualityWithRepair,
  runQualityGateAndReport,
} from './brief-quality-gate.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeMessage, makeStateWithQueue, setupProject } from '#testing/helpers/queue.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { BRIEF_QUALITY_FILE, sessionDir } from '../../../core/paths.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { briefQualityReportBytes } from '../../spec/brief-quality-file.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasks } from '../../spec/tasks/parse.js';
import { readQueueForPrompt } from '../queue/drain.js';
import { enqueueUserMessage } from '../queue/submit.js';

const completeTask = {
  id: 'T001',
  tests: ['validates email format with regex'],
  implementationSteps: ['1. Add validateEmail function'],
  scope: { inBounds: ['email validation'], outOfBounds: ['UI changes'] },
  evidence: ['test coverage shows > 90%'],
};

describe('runBriefQualityGate', () => {
  it('passes a task whose only defect is a warning', () => {
    const result = runBriefQualityGate({
      tasks: [makeTask({ ...completeTask, typeDefs: '' })],
      projectDir: process.cwd(),
    });

    expect(result.report.issues).toEqual([
      expect.objectContaining({ code: 'missing_type_definitions', severity: 'warning' }),
    ]);
    expect(result).toMatchObject({ errorCount: 0, warningCount: 1, ok: true });
  });

  it('blocks on error issues and attributes every issue to its task', () => {
    const result = runBriefQualityGate({
      tasks: [makeTask({ id: 'T001' })],
      projectDir: process.cwd(),
    });

    expect(result.report.issues.map((issue) => issue.code)).toEqual([
      'missing_scope',
      'missing_evidence',
      'missing_type_definitions',
    ]);
    expect(result.report.issues.every((issue) => issue.taskId === 'T001')).toBe(true);
    expect(result).toMatchObject({ errorCount: 2, warningCount: 1, ok: false });
  });

  it.each(['md', 'markdown'])(
    'evaluates only the real briefs when a closed %s sample quotes T900 and T901',
    (language) => {
      const marker = '```';
      const sample = `---
id: T001
title: Brief T001
action: create
file: src/T001.ts
depends_on: []
---

### Description
Create the named module.
### Tests
- returns the expected value
### Implementation Steps
1. Create the module and verify the value
### Scope
**In bounds:**
- the named module
**Out of bounds:**
- other modules
### Evidence
- the focused check passes
### Current Code
${marker}${language}
---
id: T900
title: Brief T900
action: create
file: src/T900.ts
depends_on: []
---

### Description
Create the named module.
### Tests
- returns the expected value
### Implementation Steps
1. Create the module and verify the value
### Scope
**In bounds:**
- the named module
**Out of bounds:**
- other modules
### Evidence
- the focused check passes

---
id: T901
title: Brief T901
action: create
file: src/T901.ts
depends_on: []
---

### Description
Create the named module.
### Tests
- returns the expected value
### Implementation Steps
1. Create the module and verify the value
### Scope
**In bounds:**
- the named module
**Out of bounds:**
- other modules
### Evidence
- the focused check passes

${marker}

---
id: T002
title: Brief T002
action: create
file: src/T002.ts
depends_on: []
---

### Description
Create the named module.
### Tests
- returns the expected value
### Implementation Steps
1. Create the module and verify the value
### Scope
**In bounds:**
- the named module
**Out of bounds:**
- other modules
### Evidence
- the focused check passes
### Signature
${marker}ts
export function next(): void
${marker}
`;

      const tasks = parseTasks(sample);
      expect(tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
      expect(tasks[0]?.currentCode).toContain('id: T901');

      const result = runBriefQualityGate({ tasks, projectDir: process.cwd() });
      const issueTaskIds = result.report.issues.map((issue) => String(issue.taskId));
      expect(issueTaskIds).toEqual(['T001', 'T002']);
      expect(issueTaskIds).not.toContain('T900');
      expect(issueTaskIds).not.toContain('T901');
      expect(result).toMatchObject({ errorCount: 0, warningCount: 2, ok: true });
    },
  );
});

describe('runQualityGateAndReport — the report identity', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
  });

  const passingTask = (title?: string) =>
    makeTask({
      ...completeTask,
      typeDefs: 'type Email = string',
      ...(title === undefined ? {} : { title }),
    });

  it('keeps the pass unannounced when the report already measured the same briefs', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const tasks = [passingTask()];
    const ref = { projectDir, sessionId };

    runQualityGateAndReport({ ...ref, tasks, bus, phase: 'planning' });
    runQualityGateAndReport({ ...ref, tasks, bus, phase: 'planning', sameBriefs: true });

    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
  });

  it('announces a fresh pass for different briefs that produce the same issues', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const measured = [passingTask()];
    const approved = [passingTask('A rewritten but complete brief')];
    const ref = { projectDir, sessionId };

    runQualityGateAndReport({ ...ref, tasks: measured, bus, phase: 'planning' });
    runQualityGateAndReport({
      ...ref,
      tasks: approved,
      bus,
      phase: 'reviewing-briefs',
      sameBriefs: true,
    });

    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(2);
    const report = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE), 'utf8'),
    ) as { briefHash?: string };
    expect(report.briefHash).toBe(hashTaskBrief(approved));
  });

  it('announces for briefs whose report predates the identity and carries no brief hash', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const tasks = [passingTask()];
    const ref = { projectDir, sessionId };
    writeFileSync(
      join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE),
      briefQualityReportBytes({ issues: [] }),
      'utf8',
    );

    runQualityGateAndReport({ ...ref, tasks, bus, phase: 'planning', sameBriefs: true });

    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
  });
});

describe('runBriefQualityWithRepair', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
  });

  function startPausedRepair() {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const state = {
      ...makeStateWithQueue([{ ...makeMessage('use JWT'), id: 'msg-a' }]),
      phase: 'planning' as const,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();

    let prompt = '';
    let started: () => void = () => {};
    const reviewStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (outcome: { text: string } | Error) => void = () => {};
    const reviewFinished = new Promise<{ text: string } | Error>((resolve) => {
      finish = resolve;
    });
    const planner = makePlanner({
      review: async (seen: string) => {
        prompt = seen;
        started();
        const outcome = await reviewFinished;
        if (outcome instanceof Error) throw outcome;
        return { text: outcome.text, usage: null };
      },
    });

    const running = runBriefQualityWithRepair({
      tasks: [makeTask(completeTask)],
      state,
      planner,
      projectDir,
      sessionId,
      callbacks: makeCallbacks().callbacks,
      bus,
      metadata: TEST_METADATA,
      maxRetries: 0,
    });

    const enqueueB = async () => {
      await reviewStarted;
      const enqueued = enqueueUserMessage({
        projectDir,
        sessionId,
        state,
        text: 'also add refresh tokens',
        phase: 'planning',
        bus,
      });
      if (enqueued.message === undefined) throw new Error('expected B to be queued');
      return enqueued.message.id;
    };

    return { ref, events, running, enqueueB, finish, prompt: () => prompt };
  }

  it('acknowledges only the queued input its regeneration applied', async () => {
    const { ref, events, running, enqueueB, finish, prompt } = startPausedRepair();

    const bId = await enqueueB();
    finish({ text: formatTasks([makeTask(completeTask)]) });
    const result = await running;

    expect(prompt()).toContain('use JWT');
    expect(prompt()).not.toContain('also add refresh tokens');
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ count: 1, ids: ['msg-a'] }),
    ]);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted.map((message) => [message.id, message.drainedAt !== undefined])).toEqual([
      ['msg-a', true],
      [bId, false],
    ]);
    const next = readQueueForPrompt({ ...ref, state: result.state });
    expect(next.messages.map((message) => message.id)).toEqual([bId]);
  });

  it('acknowledges neither message when the regeneration fails', async () => {
    const { ref, events, running, enqueueB, finish } = startPausedRepair();

    const bId = await enqueueB();
    finish(new Error('planner failed'));
    await expect(running).rejects.toThrow('planner failed');

    expect(events.some((event) => event.type === 'queue_drained')).toBe(false);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted.every((message) => message.drainedAt === undefined)).toBe(true);
    const state = loadState(ref);
    if (state === null) throw new Error('expected persisted workflow state');
    const next = readQueueForPrompt({ ...ref, state });
    expect(next.messages.map((message) => message.id)).toEqual(['msg-a', bId]);
  });

  it('sends the blocking issue and the recovered fence warning to the planner', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const state = {
      ...makeStateWithQueue([]),
      phase: 'planning' as const,
    };
    saveState(ref, state);
    const { bus } = makeBusRecorder();

    let prompt = '';
    let reviewCalls = 0;
    const planner = makePlanner({
      review: async (seen: string) => {
        prompt = seen;
        reviewCalls += 1;
        return { text: formatTasks([makeTask(completeTask)]), usage: null };
      },
    });

    const result = await runBriefQualityWithRepair({
      tasks: [
        makeTask({ ...completeTask, tests: [], pattern: '```ts\nconst one = 1;' }),
        makeTask({ ...completeTask, id: 'T002' }),
      ],
      state,
      planner,
      projectDir,
      sessionId,
      callbacks: makeCallbacks().callbacks,
      bus,
      metadata: TEST_METADATA,
      maxRetries: 1,
    });

    expect(prompt).toContain('Task T001 has no tests');
    expect(prompt).toContain(
      'Task T001 never closes its ```ts code fence, so the rest of the brief is read as code; the fence ends at Task T002',
    );
    expect(reviewCalls).toBe(1);
    expect(result).toMatchObject({ attempts: 2, regenerated: true });
  });

  it("repairs the briefs with the run's skills context", async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = { ...makeStateWithQueue([]), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, state);
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nREPAIR-SKILL-BODY';

    let prompt = '';
    const planner = makePlanner({
      review: async (seen: string) => {
        prompt = seen;
        return { text: formatTasks([makeTask(completeTask)]), usage: null };
      },
    });

    await runBriefQualityWithRepair({
      tasks: [makeTask({ ...completeTask, tests: [] })],
      state,
      planner,
      projectDir,
      sessionId,
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      metadata: TEST_METADATA,
      maxRetries: 1,
      skillsContext,
    });

    expect(prompt).toContain(skillsContext);
  });

  it('does not repair when canonical fence warnings leave only warnings', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const state = {
      ...makeStateWithQueue([]),
      phase: 'planning' as const,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const marker = '```';
    const sample = `---
id: T001
title: Brief T001
action: create
file: src/T001.ts
depends_on: []
---

### Description
Create the named module.
### Tests
- returns the expected value
### Implementation Steps
1. Create the module and verify the value
### Scope
**In bounds:**
- the named module
**Out of bounds:**
- other modules
### Evidence
- the focused check passes
### Pattern
${marker}ts
const one = 1;

---
id: T002
title: Brief T002
action: create
file: src/T002.ts
depends_on: []
---

### Description
Create the named module.
### Tests
- returns the expected value
### Implementation Steps
1. Create the module and verify the value
### Scope
**In bounds:**
- the named module
**Out of bounds:**
- other modules
### Evidence
- the focused check passes
### Signature
${marker}ts
export function next(): void
${marker}
`;

    const warnings: string[] = [];
    const tasks = parseTasks(sample, { onWarning: (message) => warnings.push(message) });
    expect(warnings).toEqual([
      'Task T001 never closes its ```ts code fence, so the rest of the brief is read as code; the fence ends at Task T002',
    ]);

    const gate = runBriefQualityGate({ tasks, projectDir });
    const result = await runBriefQualityWithRepair({
      tasks,
      state,
      planner,
      projectDir,
      sessionId,
      callbacks: makeCallbacks().callbacks,
      bus,
      metadata: TEST_METADATA,
      maxRetries: 1,
    });

    expect(planner.review).not.toHaveBeenCalled();
    expect(result.regenerated).toBe(false);
    expect(result.report).toEqual(gate.report);
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toEqual([]);
  });
});
