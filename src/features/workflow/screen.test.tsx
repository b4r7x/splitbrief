import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { ApprovalReviewResult, TieredApprovalRequest } from '../../core/approval/types.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { IpcServer } from '../../engine/ipc/server.js';
import { WorkflowScreen } from './screen.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from './prompt-grace.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { sessionDir } from '../../core/paths.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { createEventBus } = await import('../../engine/events/bus.js');
const { startIpcServer } = await import('../../engine/ipc/server.js');
const { configStore } = await import('../../stores/project/config.js');
const { terminalSizeStore } = await import('../../stores/ui/terminal-size.js');
const { routerStore } = await import('../../stores/navigation/router.js');
const { lifecycleStore } = await import('../../stores/workflow/lifecycle.js');
const { eventsStore } = await import('../../stores/workflow/events.js');
const { openApprovalPrompt } = await import('../../stores/approval-prompt/prompt.js');
const { openCostApprovalPrompt } = await import('../../stores/cost-approval/prompt.js');
const { createInitialState, transition } = await import('../../core/state/machine.js');
const { saveState } = await import('../../core/state/persistence.js');

const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;
const ENTER = '\r';
const CTRL_E = '\x05';
const ipcServers: IpcServer[] = [];
const ipcTempDirs: string[] = [];

function readyReadiness(projectDir: string): ReadinessReport {
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

function stickyRequest(): TieredApprovalRequest {
  return {
    tier: 'sticky',
    actionClass: 'write_out_of_scope',
    actionDescription: 'write outside task scope',
    phase: 'implementing',
  };
}

function mountWorkflow(rows = 60) {
  const projectDir = '/tmp/diptych-workflow-screen-test';
  configStore.__testReset({ config: makeConfig(), projectDir });
  terminalSizeStore.__testReset({ cols: 120, rows, isSmall: false });
  routerStore.navigate({
    to: 'workflow',
    feature: 'screen test feature',
    readiness: readyReadiness(projectDir),
  });
  return renderFeature(
    <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
  );
}

function writeFakeReviewEditor(projectDir: string): { editorPath: string; logPath: string } {
  const editorPath = join(projectDir, 'fake-review-editor.cjs');
  const logPath = join(projectDir, 'fake-review-editor.log');
  writeFileSync(
    editorPath,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const filePath = process.argv[2];
appendFileSync(process.env.FAKE_REVIEW_EDITOR_LOG, filePath + '\\n');
writeFileSync(filePath, process.env.FAKE_REVIEW_EDITOR_CONTENT);
`,
    'utf-8',
  );
  chmodSync(editorPath, 0o700);
  return { editorPath, logPath };
}

function stubReviewEditor(editorPath: string) {
  vi.stubEnv('VISUAL', '');
  vi.stubEnv('EDITOR', editorPath);
}

function workflowStateInResearching(feature: string) {
  return transition(createInitialState(feature), { type: 'START' });
}

function workflowStateInPlanning(feature: string) {
  let state = workflowStateInResearching(feature);
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  return transition(state, { type: 'APPROVE_SPEC' });
}

describe('WorkflowScreen key arbitration', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.init({ screen: 'home' });
    runWorkflow.mockReset();
    // The engine never resolves so the screen stays on the live workflow surface for the
    // duration of the test; no real planner/implementer runs.
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const server of ipcServers.splice(0)) {
      await server.close().catch(() => undefined);
    }
    for (const dir of ipcTempDirs.splice(0)) cleanupTempDir(dir);
    resetAllStores();
    routerStore.init({ screen: 'home' });
  });

  it('a pending approval prompt owns the keystroke; the focused composer does not capture it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openApprovalPrompt(stickyRequest());
    await tick(PAST_GRACE);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('Approve once');

    // A single 's' must produce exactly one semantic action: the prompt's session-approve.
    // If the composer were still focused it would also append 's' to the input box.
    ui.stdin.write('s');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'session' });
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    // The composer's input row never received the 's' (it stayed on the placeholder hint).
    expect(frame).not.toMatch(/>\s+s(\s|$)/m);

    ui.unmount();
  });

  it('protects attached IPC events before storing them in workflow stores', async () => {
    const projectDir = createTempDir('workflow-screen-attached');
    ipcTempDirs.push(projectDir);
    const bus = createEventBus();
    const server = await startIpcServer({
      sessionId: 'attached-session',
      sessionDir: projectDir,
      startedAt: 1_000,
      mode: 'standard',
      feature: 'attached feature',
      authToken: 'token',
      bus,
      onUserInput: vi.fn(),
      persistTranscript: false,
    });
    ipcServers.push(server);
    let attached = false;
    const unsubscribeAttached = bus.subscribe((event) => {
      if (event.type === 'ipc_client_attached') attached = true;
    });
    const sentinel = 'attached-ipc-raw-secret-24561';
    configStore.__testReset({
      config: makeConfig({ workflow: { persistTranscript: false } }),
      projectDir,
    });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    routerStore.navigate({
      to: 'workflow',
      feature: 'attached feature',
      sessionId: 'attached-session',
      attach: { sockPath: server.sockPath, authToken: 'token' },
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(attached).toBe(true);
    });
    unsubscribeAttached();

    bus.publish({
      type: 'runner_call_activity',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      activityId: 'activity-1',
      stage: 'updated',
      kind: 'command',
      label: `running ${sentinel}`,
      target: `target ${sentinel}`,
      textPartial: `text ${sentinel}`,
      diagnosticPartial: `diagnostic ${sentinel}`,
      rawAvailable: true,
      expandId: `expand-${sentinel}`,
      redacted: false,
    });
    await vi.waitFor(() => {
      expect(eventsStore.get().events.some((event) => event.type === 'runner_call_activity')).toBe(
        true,
      );
    });

    const event = eventsStore
      .get()
      .events.find((entry): entry is Extract<EngineEvent, { type: 'runner_call_activity' }> => {
        return entry.type === 'runner_call_activity';
      });
    expect(event).toMatchObject({
      type: 'runner_call_activity',
      label: 'running command',
    });
    expect(event).not.toHaveProperty('rawAvailable');
    expect(event).not.toHaveProperty('target');
    expect(event).not.toHaveProperty('textPartial');
    expect(event).not.toHaveProperty('diagnosticPartial');
    expect(event).not.toHaveProperty('expandId');
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`target ${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`text ${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`diagnostic ${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`expand-${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(sentinel);
    ui.unmount();
  });

  it('shows active approval commands instead of the queue hint while attached', async () => {
    const projectDir = createTempDir('workflow-screen-attached-prompt');
    ipcTempDirs.push(projectDir);
    const attachedSessionId = 'attached-prompt-session';
    const attachedSessionDir = sessionDir(projectDir, attachedSessionId);
    mkdirSync(attachedSessionDir, { recursive: true });
    writeFileSync(
      join(attachedSessionDir, 'tasks.md'),
      formatTasks([
        makeTask({
          id: 'T001',
          title: 'Attached prompt task',
          file: 'src/attached-prompt.ts',
          evidence: ['reviewable proof'],
          scope: { inBounds: ['src/attached-prompt.ts'], outOfBounds: [] },
        }),
      ]),
      'utf-8',
    );
    const bus = createEventBus();
    const serverDir = createTempDir('wsa');
    ipcTempDirs.push(serverDir);
    const server = await startIpcServer({
      sessionId: attachedSessionId,
      sessionDir: serverDir,
      startedAt: 1_000,
      mode: 'standard',
      feature: 'attached prompt feature',
      authToken: 'token',
      bus,
      onUserInput: vi.fn(),
      persistTranscript: false,
    });
    ipcServers.push(server);
    let attached = false;
    const unsubscribeAttached = bus.subscribe((event) => {
      if (event.type === 'ipc_client_attached') attached = true;
    });
    configStore.__testReset({
      config: makeConfig({ workflow: { persistTranscript: false } }),
      projectDir,
    });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    routerStore.navigate({
      to: 'workflow',
      feature: 'attached prompt feature',
      sessionId: attachedSessionId,
      attach: { sockPath: server.sockPath, authToken: 'token' },
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(attached).toBe(true);
    });
    unsubscribeAttached();

    const response = server.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: 'tasks.md',
    });

    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('approve | Ctrl+E/e edit');
      expect(frame).not.toContain('queue message to running workflow');
    });

    ui.stdin.write('reject');
    await tick(20);
    ui.stdin.write(ENTER);
    await expect(response).resolves.toEqual({
      kind: 'approval_needed',
      approved: false,
    });

    ui.unmount();
  });

  it('keeps a pending approval prompt answerable on a terminal too short to render it', async () => {
    // rows=6 with the default 3-row composer leaves no middle budget, so the prompt clamps to
    // zero rows. The handler must still be registered or the prompt deadlocks unanswerably.
    const ui = mountWorkflow(6);
    await tick(20);

    const decision = openApprovalPrompt(stickyRequest());
    await tick(PAST_GRACE);
    await tick(20);

    ui.stdin.write('s');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'session' });

    ui.unmount();
  });

  it('ignores a keystroke buffered into the grace window, then honours it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openApprovalPrompt(stickyRequest());
    await tick(20);

    // The 'x' arrives inside the grace window (a keystroke meant for the composer that was
    // in flight when the prompt opened). It must not deny the prompt.
    ui.stdin.write('x');
    await tick(20);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(20);
    expect(settled).toBe(false);

    await tick(PAST_GRACE);
    ui.stdin.write('x');
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });

    ui.unmount();
  });

  it('a pending cost prompt owns y/n; the composer stays disabled', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openCostApprovalPrompt({
      estimatedTasks: 3,
      lowCost: 0.01,
      expectedCost: 0.02,
      highCost: 0.05,
      plannerTool: 'anthropic',
      implementerTool: 'anthropic',
      deterministic: {
        taskCount: 3,
        taskFitCounts: { fits: 3, tight: 0, overflow: 0, unknown: 0 },
        contextConfidenceCounts: {
          contextExplicit: 3,
          contextDetected: 0,
          contextKnownCatalog: 0,
          contextCachedProvider: 0,
          contextConservativeFallback: 0,
          profileUnavailable: 0,
        },
        priceConfidenceCounts: { priceKnown: 3, priceUnknown: 0, profileUnavailable: 0 },
        tasks: [],
        totals: {
          knownActualEstimate: 0.02,
          hypotheticalAllPlanner: 0.1,
          estimatedSavings: 0.08,
          unknownCostReason: [],
        },
      },
    });
    await tick(PAST_GRACE);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('Cost Approval Required');

    ui.stdin.write('n');
    await expect(decision).resolves.toBe(false);

    ui.unmount();
  });

  it('the composer captures a printable key while no review prompt is active', async () => {
    const ui = mountWorkflow();
    await tick(20);

    // Control: outside brief review the composer owns printable keystrokes.
    ui.stdin.write('j');
    await tick(20);

    expect(ui.lastFrame() ?? '').toMatch(/>\s+j(\s|$)/m);

    ui.unmount();
  });

  it('routes completion with the runner-generated session id without reading the active pointer', async () => {
    const projectDir = createTempDir('workflow-screen-complete');
    try {
      const summary = makeSummary({ feature: 'generated completion id' });
      runWorkflow.mockImplementation(async (opts) => {
        opts.callbacks.onComplete(summary);
        return summary;
      });
      configStore.__testReset({ config: makeConfig(), projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        feature: 'generated completion id',
        readiness: readyReadiness(projectDir),
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        expect(routerStore.get().screen).toBe('summary');
      });

      const firstCall = runWorkflow.mock.calls[0];
      if (!firstCall) throw new Error('expected runWorkflow to be called');
      const route = routerStore.get();
      expect(readActive(projectDir)).toBeNull();
      expect(firstCall[0].sessionId).toMatch(/^\d{4}-\d{2}-\d{2}-generated-completion-id/);
      if (route.screen === 'summary') {
        expect(route.summary).toEqual(summary);
        expect(route.sessionId).toBe(firstCall[0].sessionId);
        expect(route.status).toBe('complete');
      }

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('routes final-review failures as interrupted summaries instead of defaulting to complete', async () => {
    const projectDir = createTempDir('workflow-screen-final-review-failed');
    try {
      const summary = makeSummary({ feature: 'final review failure' });
      runWorkflow.mockImplementation(async (opts) => {
        if (!opts.sessionId) throw new Error('expected generated session id');
        saveState(
          { projectDir, sessionId: opts.sessionId },
          { ...createInitialState('final review failure'), phase: 'final-review' },
        );
        return summary;
      });
      configStore.__testReset({ config: makeConfig(), projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        feature: 'final review failure',
        readiness: readyReadiness(projectDir),
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        expect(routerStore.get().screen).toBe('summary');
      });

      const route = routerStore.get();
      if (route.screen === 'summary') {
        expect(route.summary).toEqual(summary);
        expect(route.status).toBe('interrupted');
      }

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('does not promise or attempt resume after a non-resumable cancelled state', async () => {
    const projectDir = createTempDir('workflow-screen-cancel-non-resumable');
    try {
      const sessionId = 'cancelled-researching';
      const saved = workflowStateInResearching('cancel before planning');
      saveState({ projectDir, sessionId }, saved);
      configStore.__testReset({ config: makeConfig(), projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        feature: saved.feature,
        resumeState: saved,
        sessionId,
        readiness: readyReadiness(projectDir),
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );
      await tick(20);
      expect(runWorkflow).toHaveBeenCalledTimes(1);

      lifecycleStore.__testReset({
        phase: 'researching',
        status: 'cancelled',
        cancelled: true,
        reason: 'user_cancelled',
      });
      await tick(20);

      expect(ui.lastFrame() ?? '').not.toContain('Enter to resume');

      ui.stdin.write(ENTER);
      await tick(40);

      expect(runWorkflow).toHaveBeenCalledTimes(1);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('keeps Enter resume available for a cancelled state that is resumable for this session', async () => {
    const projectDir = createTempDir('workflow-screen-cancel-resumable');
    try {
      const sessionId = 'cancelled-planning';
      const saved = workflowStateInPlanning('cancel during planning');
      saveState({ projectDir, sessionId }, saved);
      configStore.__testReset({ config: makeConfig(), projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        feature: saved.feature,
        resumeState: saved,
        sessionId,
        readiness: readyReadiness(projectDir),
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );
      await tick(20);
      expect(runWorkflow).toHaveBeenCalledTimes(1);

      lifecycleStore.__testReset({
        phase: 'planning',
        status: 'cancelled',
        cancelled: true,
        reason: 'user_cancelled',
      });
      await tick(20);

      ui.stdin.write(ENTER);

      await vi.waitFor(() => {
        expect(runWorkflow).toHaveBeenCalledTimes(2);
      });
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('the focused composer still captures printable keys while no review prompt is active', async () => {
    const ui = mountWorkflow();
    await tick(20);

    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    await tick(20);

    ui.stdin.write('j');
    await tick(20);

    expect(ui.lastFrame() ?? '').toMatch(/>\s+j(\s|$)/m);

    ui.unmount();
  });

  it('configured rich brief review still uses the simple review surface and workflow footer', async () => {
    const projectDir = createTempDir('workflow-screen-rich-footer');
    try {
      const tasksPath = join(projectDir, 'tasks.md');
      writeFileSync(
        tasksPath,
        formatTasks([
          makeTask({
            id: 'T001',
            title: 'Rich footer task',
            file: 'src/rich-footer.ts',
            evidence: ['reviewable proof'],
            scope: { inBounds: ['src/rich-footer.ts'], outOfBounds: [] },
          }),
        ]),
        'utf-8',
      );
      configStore.__testReset({
        config: makeConfig({ workflow: { briefReview: 'rich' } }),
        projectDir,
      });
      terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        feature: 'rich footer review',
        readiness: readyReadiness(projectDir),
      });
      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
        await opts.callbacks.onApprovalNeeded('briefs', tasksPath);
        return makeSummary({ feature: 'rich footer review' });
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Rich footer task');
        expect(ui.lastFrame() ?? '').toContain('approve | Ctrl+E/e edit-file');
      });
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Ctrl+C abort');
      expect(frame).not.toContain('tab sections');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('Ctrl+E opens the external editor for brief review and resolves the edit action', async () => {
    const projectDir = createTempDir('workflow-screen-brief-shortcut');
    try {
      const tasksPath = join(projectDir, 'tasks.md');
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      const editedText = formatTasks([
        makeTask({
          id: 'T001',
          title: 'Review shortcut task edited',
          file: 'src/review-shortcut.ts',
          evidence: ['reviewable proof'],
          scope: { inBounds: ['src/review-shortcut.ts'], outOfBounds: [] },
        }),
      ]);
      writeFileSync(
        tasksPath,
        formatTasks([
          makeTask({
            id: 'T001',
            title: 'Review shortcut task',
            file: 'src/review-shortcut.ts',
            evidence: ['reviewable proof'],
            scope: { inBounds: ['src/review-shortcut.ts'], outOfBounds: [] },
          }),
        ]),
        'utf-8',
      );
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', editedText);
      let approvalResult: ApprovalReviewResult | undefined;

      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
        approvalResult = await opts.callbacks.onApprovalNeeded('briefs', tasksPath);
        return makeSummary();
      });
      const ui = mountWorkflow();

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Review shortcut task');
      });

      ui.stdin.write(CTRL_E);

      await vi.waitFor(() => {
        expect(approvalResult).toEqual({ approved: false, action: 'edit' });
      });
      expect(readFileSync(logPath, 'utf-8')).toContain(tasksPath);
      expect(readFileSync(tasksPath, 'utf-8')).toContain('Review shortcut task edited');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it.each([
    ['spec', 'reviewing-spec'],
    ['plan', 'reviewing-plan'],
  ] as const)('Ctrl+E opens the external editor for %s review and refreshes before approval', async (type, phase) => {
    const projectDir = createTempDir(`workflow-screen-${type}-editor`);
    try {
      const reviewPath = join(projectDir, `${type}.md`);
      const { editorPath, logPath } = writeFakeReviewEditor(projectDir);
      const editedText = `# Edited ${type} review\n\nfresh editor content\n`;
      writeFileSync(reviewPath, `# Original ${type} review\n\nstale content\n`, 'utf-8');
      stubReviewEditor(editorPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_LOG', logPath);
      vi.stubEnv('FAKE_REVIEW_EDITOR_CONTENT', editedText);
      let approvalResult: ApprovalReviewResult | undefined;

      runWorkflow.mockImplementationOnce(async (opts) => {
        lifecycleStore.__testReset({ phase });
        approvalResult = await opts.callbacks.onApprovalNeeded(type, reviewPath);
        return makeSummary({ feature: `${type} review editor` });
      });

      const ui = mountWorkflow();

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain(`Original ${type} review`);
      });

      ui.stdin.write(CTRL_E);

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain(`Edited ${type} review`);
      });
      expect(readFileSync(logPath, 'utf-8')).toContain(reviewPath);
      expect(approvalResult).toBeUndefined();

      ui.stdin.write('approve');
      await tick(20);
      ui.stdin.write(ENTER);

      await vi.waitFor(() => {
        expect(approvalResult).toEqual({ approved: true });
      });

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
