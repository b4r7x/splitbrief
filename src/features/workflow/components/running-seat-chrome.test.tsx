import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { configStore } from '../../../stores/project/config.js';
import {
  operationsStore,
  type ActiveOperation,
} from '../../../stores/workflow/operations/state.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { markCancellationRequested } from '../../../stores/workflow/actions/interrupt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { PLANNER_INHERITANCE } from '../../../core/crew/identity.js';
import { Header } from './header.js';
import { Sidebar } from './sidebar.js';

const originalColorLevel = chalk.level;

const CLAUDE_SEAT = {
  kind: 'cli' as const,
  tool: 'claude-code' as const,
  model: 'claude-3-5-sonnet',
};

function makeActiveOp(overrides: Partial<ActiveOperation> = {}): ActiveOperation {
  return {
    callId: 'call-1',
    role: 'review',
    phase: 'final-review',
    label: 'Reviewing',
    status: 'running',
    startedAt: 1_000,
    endedAt: null,
    durationMs: null,
    partial: false,
    reason: null,
    usage: null,
    warnings: [],
    runnerName: 'codex',
    model: 'gpt-5-codex',
    backendKind: 'cli',
    ...overrides,
  } as ActiveOperation;
}

async function headerFrame(cols = 160): Promise<string> {
  terminalSizeStore.__testReset({ cols, rows: 24, isSmall: cols < 120 });
  const ui = renderFeature(<Header />);
  await tick();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame;
}

async function sidebarFrame(width = 50): Promise<string> {
  const ui = renderFeature(<Sidebar width={width} />);
  await tick();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame;
}

beforeEach(() => {
  resetAllStores();
  modelCacheStore.reset();
  modelCacheStore.hydrateDetection({
    providers: [],
    cliTools: [],
    fetchedAt: 1,
    validatedAt: 1,
    generation: 0,
    requestId: 0,
    contexts: { readiness: 'readiness', modelsDev: 'catalog', cliModels: 'tools' },
    cliCatalogs: [
      {
        tool: 'codex',
        probedAt: 1,
        models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }],
      },
      {
        tool: 'claude-code',
        probedAt: 1,
        models: [{ id: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet' }],
      },
    ],
  });
  configStore.__testReset({
    projectDir: '/tmp/project',
    config: makeConfig({
      planner: CLAUDE_SEAT,
      implementer: CLAUDE_SEAT,
      reviewer: CLAUDE_SEAT,
    }),
  });
});

afterEach(() => {
  chalk.level = originalColorLevel;
  vi.unstubAllEnvs();
  resetAllStores();
});

describe('running seat chrome', () => {
  it('renders Header and Sidebar naming Codex while review call runs on Codex and saved reviewer is Claude Code', async () => {
    operationsStore.__testReset({
      active: makeActiveOp({
        role: 'review',
        phase: 'final-review',
        runnerName: 'codex',
        model: 'gpt-5-codex',
      }),
    });

    const header = await headerFrame();
    expect(header).toContain('REVIEW');
    expect(header).toContain('Codex');

    const sidebar = await sidebarFrame();
    expect(sidebar).toContain('REVIEW');
    expect(sidebar).toContain('Codex');
  });

  it('renders Header and Sidebar naming Codex while plan call runs on Codex', async () => {
    operationsStore.__testReset({
      active: makeActiveOp({
        role: 'planner',
        phase: 'planning',
        runnerName: 'codex',
        model: 'gpt-5-codex',
      }),
    });

    const header = await headerFrame();
    expect(header).toContain('PLAN');
    expect(header).toContain('Codex');

    const sidebar = await sidebarFrame();
    expect(sidebar).toContain('PLAN');
    expect(sidebar).toContain('Codex');
  });

  it('renders Header and Sidebar naming Codex while build call runs on Codex', async () => {
    operationsStore.__testReset({
      active: makeActiveOp({
        role: 'implementer',
        phase: 'implementing',
        runnerName: 'codex',
        model: 'gpt-5-codex',
      }),
    });

    const header = await headerFrame();
    expect(header).toContain('BUILD');
    expect(header).toContain('Codex');

    const sidebar = await sidebarFrame();
    expect(sidebar).toContain('BUILD');
    expect(sidebar).toContain('Codex');
  });

  it('reads saved config for Header and Sidebar after operation completes', async () => {
    operationsStore.__testReset({
      active: makeActiveOp({
        status: 'completed',
        role: 'review',
        runnerName: 'codex',
        model: 'gpt-5-codex',
      }),
    });

    const header = await headerFrame();
    expect(header).toContain('Sonnet');
    expect(header).not.toContain('Codex');

    const sidebar = await sidebarFrame();
    expect(sidebar).toContain('Claude Code');
    expect(sidebar).not.toContain('Codex');
  });

  it('reads saved config on reopened run when no call is running', async () => {
    operationsStore.__testReset({ active: null });

    const header = await headerFrame();
    expect(header).toContain('Sonnet');
    expect(header).not.toContain('Codex');

    const sidebar = await sidebarFrame();
    expect(sidebar).toContain('Claude Code');
    expect(sidebar).not.toContain('Codex');
  });

  it('overrides inherited reviewer with running seat on Sidebar and restores inheritance when done', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: CLAUDE_SEAT }),
    });
    operationsStore.__testReset({
      active: makeActiveOp({
        role: 'review',
        phase: 'final-review',
        runnerName: 'codex',
        model: 'gpt-5-codex',
      }),
    });

    const activeSidebar = await sidebarFrame();
    expect(activeSidebar).toContain('REVIEW');
    expect(activeSidebar).toContain('Codex');
    expect(activeSidebar).not.toContain(PLANNER_INHERITANCE.mark);

    const activeHeader = await headerFrame();
    expect(activeHeader).toContain('REVIEW');
    expect(activeHeader).toContain('Codex');

    operationsStore.__testReset({ active: null });

    const idleSidebar = await sidebarFrame();
    expect(idleSidebar).toContain(PLANNER_INHERITANCE.mark);
  });
});

const CODEX_SEAT = { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5-codex' };

function saveCrew(crew: Parameters<typeof makeConfig>[0] = {}): void {
  configStore.__testReset({
    projectDir: '/tmp/project',
    config: makeConfig({
      planner: CLAUDE_SEAT,
      implementer: CLAUDE_SEAT,
      reviewer: CLAUDE_SEAT,
      ...crew,
    }),
  });
}

function buildCall(type: string, callId: string, ts: number, extra: object = {}): EngineEvent {
  return {
    type,
    ts,
    phase: 'implementing',
    taskId: 'T021',
    callId,
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'gpt-5-codex',
    axes: [],
    attempt: 0,
    ...(type === 'runner_call_completed' && {
      startedAt: ts - 100,
      endedAt: ts,
      durationMs: 100,
      usage: null,
      nativeSessionId: null,
    }),
    ...extra,
  } as unknown as EngineEvent;
}

function startBriefOnCodex(): void {
  saveCrew({ implementer: CODEX_SEAT });
  addEvent({
    type: 'workflow_started',
    ts: 800,
    phase: 'implementing',
    feature: 'f',
  } as EngineEvent);
  addEvent({
    type: 'task_started',
    ts: 900,
    phase: 'implementing',
    taskId: 'T021',
    title: 'Brief',
    index: 0,
    total: 2,
    file: 'a.ts',
    action: 'modify',
    tool: 'codex',
    model: 'gpt-5-codex',
    axes: [],
    backendKind: 'cli',
    lineageAttempt: 1,
    attemptAllowance: 8,
  } as unknown as EngineEvent);
  addEvent(buildCall('runner_call_started', 'call-1', 1_000));
  saveCrew();
  addEvent(buildCall('runner_call_completed', 'call-1', 2_000));
}

async function buildRows(): Promise<{ header: string; sidebar: string }> {
  const row = (frame: string) =>
    frame
      .split('\n')
      .filter((line) => line.includes('BUILD'))
      .join(' ');
  return { header: row(await headerFrame()), sidebar: row(await sidebarFrame()) };
}

describe('running brief seat chrome', () => {
  it('names the brief seat between its attempts, during its checks and its retry, then the saved seat after it', async () => {
    startBriefOnCodex();

    expect(await buildRows()).toMatchObject({
      header: expect.stringContaining('Codex'),
      sidebar: expect.stringContaining('Codex'),
    });

    addEvent({
      type: 'task_validating',
      ts: 2_100,
      phase: 'implementing',
      taskId: 'T021',
      check: { id: 'chk-unit', command: 'npm test' },
    } as unknown as EngineEvent);
    addEvent({
      type: 'task_retry',
      ts: 3_000,
      phase: 'implementing',
      taskId: 'T021',
      attempt: 1,
      maxRetries: 8,
      lineageAttempt: 2,
      attemptAllowance: 8,
      error: 'chk-unit failed',
    } as unknown as EngineEvent);
    const retry = await buildRows();
    expect(retry.header).toContain('Codex');
    expect(retry.sidebar).toContain('Codex');

    addEvent({
      type: 'task_completed',
      ts: 4_000,
      phase: 'implementing',
      taskId: 'T021',
      title: 'Brief',
      method: 'local',
    } as unknown as EngineEvent);
    const after = await buildRows();
    expect(after.header).not.toContain('Codex');
    expect(after.sidebar).toContain('Claude Code');
  });

  it('names the brief seat while an escalation call runs inside the brief', async () => {
    startBriefOnCodex();
    addEvent(
      buildCall('runner_call_started', 'esc-1', 2_500, {
        role: 'escalation',
        phase: 'escalating',
        runnerName: 'claude',
        model: 'claude-3-5-sonnet',
      }),
    );

    const rows = await buildRows();
    expect(rows.header).toContain('Codex');
    expect(rows.sidebar).toContain('Codex');
  });

  it('names the saved seat after a stop inside the brief', async () => {
    startBriefOnCodex();
    markCancellationRequested();

    const rows = await buildRows();
    expect(rows.header).not.toContain('Codex');
    expect(rows.sidebar).toContain('Claude Code');
  });

  it('names the saved seat while a halt inside the brief waits', async () => {
    startBriefOnCodex();
    recoveryNoticeStore.open({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: makeRecoveryIssue({ taskId: taskId('T021') }),
      at: { kind: 'brief', taskId: taskId('T021'), attempt: 0 },
    });

    const rows = await buildRows();
    expect(rows.header).not.toContain('Codex');
    expect(rows.sidebar).toContain('Claude Code');
  });

  it('names the saved seat once the run resumes inside the brief, before the brief starts again', async () => {
    startBriefOnCodex();
    addEvent({ type: 'workflow_resumed', ts: 5_000, phase: 'implementing' } as EngineEvent);

    const rows = await buildRows();
    expect(rows.header).not.toContain('Codex');
    expect(rows.sidebar).toContain('Claude Code');
  });

  it('names the fallback seat after a Seat down switch inside the brief', async () => {
    startBriefOnCodex();
    saveCrew({ implementer: CODEX_SEAT });
    recoveryNoticeStore.open({
      seat: 'build',
      ranOn: null,
      resetAt: null,
      issue: makeRecoveryIssue({ reason: 'runner-usage-limit', taskId: taskId('T021') }),
      at: { kind: 'brief', taskId: taskId('T021'), attempt: 0 },
    });
    saveCrew();
    addEvent({
      type: 'seat_switched',
      ts: 5_000,
      phase: 'implementing',
      seat: 'build',
      from: 'OpenAI Codex CLI · GPT-5 Codex',
      to: 'Claude Code CLI · Claude 3.5 Sonnet',
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'r2',
    } as unknown as EngineEvent);
    recoveryNoticeStore.clear();
    addEvent({ type: 'workflow_resumed', ts: 5_100, phase: 'implementing' } as EngineEvent);

    const resumed = await buildRows();
    expect(resumed.header).not.toContain('Codex');
    expect(resumed.sidebar).toContain('Claude Code');

    addEvent({
      type: 'task_started',
      ts: 5_200,
      phase: 'implementing',
      taskId: 'T021',
      title: 'Brief',
      index: 0,
      total: 2,
      file: 'a.ts',
      action: 'modify',
      tool: 'claude-code',
      model: 'claude-3-5-sonnet',
      axes: [],
      backendKind: 'cli',
      lineageAttempt: 2,
      attemptAllowance: 8,
    } as unknown as EngineEvent);
    const restarted = await buildRows();
    expect(restarted.header).not.toContain('Codex');
    expect(restarted.sidebar).toContain('Claude Code');
  });

  it('keeps the PLAN effort word while the planning status stands for the seat', async () => {
    saveCrew({ planner: { ...CLAUDE_SEAT, effort: 'high' } });
    addEvent({
      type: 'planner_status',
      ts: 1_000,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'claude-3-5-sonnet',
    } as EngineEvent);

    expect(await sidebarFrame()).toContain('Claude 3.5 Sonnet · high');
  });

  it.each([
    { kind: 'shell' as const, command: './impl.sh', model: 'auto', name: 'Custom Shell' },
    { kind: 'agent' as const, command: 'my-agent', model: 'local-7b', name: 'Agent' },
  ])('keeps the $kind BUILD seat name while its call runs', async ({ name, ...seat }) => {
    saveCrew({ implementer: seat });
    operationsStore.__testReset({
      active: makeActiveOp({
        role: 'implementer',
        phase: 'implementing',
        runnerName: seat.command,
        model: seat.model,
        axes: [],
        backendKind: seat.kind,
      }),
    });

    const rows = await buildRows();
    expect(rows.sidebar).toContain(name);
    expect(rows.sidebar).not.toContain(seat.command);
  });

  it('keeps = PLAN on both surfaces while a shell planner that holds the review seat runs a review call', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'shell', command: './plan.sh', model: 'auto' } }),
    });
    operationsStore.__testReset({
      active: makeActiveOp({
        role: 'review',
        phase: 'final-review',
        runnerName: './plan.sh',
        model: 'auto',
        axes: [],
        backendKind: 'shell',
      }),
    });

    expect(await headerFrame()).toContain(`REVIEW ${PLANNER_INHERITANCE.mark}`);
    const review = (await sidebarFrame()).split('\n').find((line) => line.includes('REVIEW'));
    expect(review).toContain(PLANNER_INHERITANCE.mark);
  });
});
