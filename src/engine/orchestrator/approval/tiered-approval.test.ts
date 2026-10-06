import { describe, it, expect, afterEach } from 'vitest';
import { gateAction } from './tiered-approval.js';
import type { GateActionInput } from './types.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import { makeConfig, makeApprovalConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createEvidenceLedger, withAppendedApproval } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';

const CONFIRMED = async () =>
  ({ decision: 'confirm', phrase: 'I confirm', reason: 'needed' }) as const;

let dirs: string[] = [];

function trackTempDir(name: string): string {
  const dir = createTempDir(name);
  dirs.push(dir);
  return dir;
}

type InputOverrides = Partial<Omit<GateActionInput, 'callbacks'>> & {
  onTieredApproval?: OrchestratorCallbacks['onTieredApproval'];
};

function makeInput({ onTieredApproval, ...overrides }: InputOverrides = {}): GateActionInput {
  const { bus } = makeBusRecorder();
  const task = makeTask();
  return {
    actionDescription: 'modify src/foo.ts',
    targetPath: 'src/foo.ts',
    task,
    dependsOnFiles: [],
    projectDir: trackTempDir('splitbrief-test'),
    sessionId: 'sess-001',
    phase: 'implementing',
    taskId: task.id,
    bus,
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onComplete: () => {},
      ...(onTieredApproval && { onTieredApproval }),
    },
    config: makeConfig(),
    ...overrides,
  };
}

function grantedEvent(events: EngineEvent[]) {
  return events.find((e) => e.type === 'approval_granted');
}

function rejectedEvent(events: EngineEvent[]) {
  return events.find((e) => e.type === 'approval_rejected');
}

describe('gateAction', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
    if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  it('an unplanned ordinary write is auto by default', async () => {
    const { bus, events } = makeBusRecorder();
    const result = await gateAction(
      makeInput({
        bus,
        actionDescription: 'write src/shared/button.ts',
        targetPath: 'src/shared/button.ts',
      }),
    );
    expect(result.allow).toBe(true);
    expect(events.filter((e) => e.type === 'approval_prompted')).toHaveLength(0);
  });

  it('a protected write asks whatever a retired approval.enabled says', async () => {
    const { bus, events } = makeBusRecorder();
    let asked = 0;
    const result = await gateAction(
      makeInput({
        bus,
        config: makeConfig({ approval: { enabled: false, feedRejectionsToPlanner: true } }),
        actionDescription: 'write .env.local',
        targetPath: '.env.local',
        onTieredApproval: async () => {
          asked += 1;
          return CONFIRMED();
        },
      }),
    );
    expect(asked).toBe(1);
    expect(result.allow).toBe(true);
    expect(events.find((e) => e.type === 'approval_prompted')?.tier).toBe('confirm');
  });

  it('a confirmation the run already granted holds for the same path and operation', async () => {
    const projectDir = trackTempDir('splitbrief-test');
    const task = makeTask();
    writeEvidenceLedger(
      { projectDir, sessionId: 'sess-001' },
      withAppendedApproval(
        createEvidenceLedger({ sessionId: 'sess-001', feature: 'f', tasks: [task] }),
        {
          ts: new Date().toISOString(),
          tier: 'confirm',
          actionClass: 'package_change',
          actionDescription: 'write package.json',
          reason: 'add a script',
        },
      ),
    );
    let asked = 0;
    const ask = async () => {
      asked += 1;
      return CONFIRMED();
    };
    const same = await gateAction(
      makeInput({
        projectDir,
        task,
        actionDescription: 'write package.json',
        targetPath: 'package.json',
        onTieredApproval: ask,
      }),
    );
    expect(same.allow).toBe(true);
    expect(same.confirmApprovals).toBeUndefined();
    expect(asked).toBe(0);

    const other = await gateAction(
      makeInput({
        projectDir,
        task,
        actionDescription: 'write pnpm-lock.yaml',
        targetPath: 'pnpm-lock.yaml',
        onTieredApproval: ask,
      }),
    );
    expect(other.allow).toBe(true);
    expect(asked).toBe(1);
  });

  it('auto tier → allow, no events emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeConfig();
    const input = makeInput({ bus, config, actionDescription: 'read src/foo.ts' });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(events.filter((e) => e.type === 'approval_prompted')).toHaveLength(0);
  });

  it('confirm tier, no callback → deny APPROVAL_REQUIRED', async () => {
    const { bus } = makeBusRecorder();
    const config = makeApprovalConfig();
    const input = makeInput({
      bus,
      config,
      actionDescription: 'write package.json',
      targetPath: 'package.json',
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('APPROVAL_REQUIRED');
  });

  it('confirm tier, wrong phrase → deny invalid_confirm_phrase', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig();
    const input = makeInput({
      bus,
      config,
      actionDescription: 'write package.json',
      targetPath: 'package.json',
      onTieredApproval: async () => ({
        decision: 'confirm',
        phrase: 'yes please',
        reason: 'I understand',
      }),
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('invalid_confirm_phrase');
    expect(rejectedEvent(events)?.reason).toBe('invalid_confirm_phrase');
  });

  it('confirm tier, callback deny → deny, approval_rejected emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig();
    const input = makeInput({
      bus,
      config,
      actionDescription: 'write package.json',
      targetPath: 'package.json',
      onTieredApproval: async () => ({ decision: 'deny', reason: 'not allowed' }),
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('not allowed');
    expect(rejectedEvent(events)?.reason).toBe('not allowed');
  });

  it('confirm tier, valid confirm → approval_granted event records confirmReason', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig();
    const input = makeInput({
      bus,
      config,
      actionDescription: 'write package.json',
      targetPath: 'package.json',
      onTieredApproval: async () => ({
        decision: 'confirm',
        phrase: 'I confirm',
        reason: 'cleaning stale fixtures',
      }),
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(result.confirmReason).toBe('cleaning stale fixtures');
    const granted = grantedEvent(events);
    expect(granted).toBeDefined();
    expect(granted?.scope).toBe('once');
    expect(granted?.confirmReason).toBe('cleaning stale fixtures');
  });
});
