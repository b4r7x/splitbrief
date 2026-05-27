import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gateAction } from './tiered-approval.js';
import type { GateActionInput } from './tiered-approval.js';
import type { TieredApprovalResponse } from '../../../core/approval/types.js';
import type { EngineEvent } from '../../events/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { approvalsFile, DIPTYCH_DIR } from '../../../core/paths.js';

type ConfigOverrides = NonNullable<Parameters<typeof makeConfig>[0]>;
type ApprovalConfig = NonNullable<ConfigOverrides['approval']>;

function makeApprovalConfig(approval: Pick<ApprovalConfig, 'enabled'> & Partial<ApprovalConfig>) {
  return makeConfig({
    approval: {
      enabled: approval.enabled,
      feedRejectionsToPlanner: approval.feedRejectionsToPlanner ?? true,
      ...(approval.headless !== undefined && { headless: approval.headless }),
      ...(approval.tiers !== undefined && { tiers: approval.tiers }),
      ...(approval.allowedPaths !== undefined && { allowedPaths: approval.allowedPaths }),
    },
  });
}

function makeInput(overrides: Partial<GateActionInput> = {}): GateActionInput {
  const { bus } = makeBusRecorder();
  const task = makeTask();
  return {
    actionDescription: 'modify src/foo.ts',
    task,
    dependsOnFiles: [],
    projectDir: createTempDir('diptych-test'),
    sessionId: 'sess-001',
    phase: 'implementing',
    taskId: task.id,
    bus,
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),

      onComplete: () => {},
    },
    config: makeConfig(),
    ...overrides,
  };
}

describe('gateAction', () => {
  it('approval.enabled=false → allow immediately without events', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: false });
    const input = makeInput({ bus, config });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('auto tier → allow, no events emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeConfig();
    const input = makeInput({ bus, config, actionDescription: 'read src/foo.ts' });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(events.filter(e => e.type === 'approval_prompted')).toHaveLength(0);
  });

  it('sticky tier, no grant, no callback → deny APPROVAL_REQUIRED', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true, headless: true });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
      },
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('APPROVAL_REQUIRED');
    expect(events.some(e => e.type === 'approval_prompted')).toBe(true);
  });

  it('sticky tier, always grant exists → allow without callback', async () => {
    const { bus, events } = makeBusRecorder();
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
    const store = {
      version: 1,
      grants: [{
        pattern: 'write /tmp/outside-project/file.ts',
        class: 'write_out_of_scope',
        scope: 'always',
        grantedAt: new Date().toISOString(),
      }],
    };
    writeFileSync(approvalsFile(projectDir), JSON.stringify(store));
    const config = makeApprovalConfig({ enabled: true, headless: true });
    let callbackCalled = false;
    const input = makeInput({
      bus,
      config,
      projectDir,
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async () => { callbackCalled = true; return { decision: 'allow', scope: 'once' }; },
      },
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(callbackCalled).toBe(false);
    const granted = events.find(e => e.type === 'approval_granted') as Extract<EngineEvent, { type: 'approval_granted' }> | undefined;
    expect(granted?.scope).toBe('always');
    expect(events.some(e => e.type === 'approval_prompted')).toBe(false);
  });

  it('sticky tier, session grant matching sessionId → allow without callback', async () => {
    const { bus, events } = makeBusRecorder();
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
    const store = {
      version: 1,
      grants: [{
        pattern: 'write /tmp/outside-project/file.ts',
        class: 'write_out_of_scope',
        scope: 'session',
        sessionId: 'sess-001',
        grantedAt: new Date().toISOString(),
      }],
    };
    writeFileSync(approvalsFile(projectDir), JSON.stringify(store));
    const config = makeApprovalConfig({ enabled: true, headless: true });
    let callbackCalled = false;
    const input = makeInput({
      bus,
      config,
      projectDir,
      sessionId: 'sess-001',
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async () => { callbackCalled = true; return { decision: 'allow', scope: 'once' }; },
      },
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(callbackCalled).toBe(false);
    const granted = events.find(e => e.type === 'approval_granted') as Extract<EngineEvent, { type: 'approval_granted' }> | undefined;
    expect(granted?.scope).toBe('session');
    expect(events.some(e => e.type === 'approval_prompted')).toBe(false);
  });

  it('sticky tier, session grant for different sessionId → callback invoked', async () => {
    const { bus } = makeBusRecorder();
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
    const store = {
      version: 1,
      grants: [{
        pattern: 'write /tmp/outside-project/file.ts',
        class: 'write_out_of_scope',
        scope: 'session',
        sessionId: 'sess-OTHER',
        grantedAt: new Date().toISOString(),
      }],
    };
    writeFileSync(approvalsFile(projectDir), JSON.stringify(store));
    const config = makeApprovalConfig({ enabled: true });
    let callbackCalled = false;
    const input = makeInput({
      bus,
      config,
      projectDir,
      sessionId: 'sess-001',
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async () => { callbackCalled = true; return { decision: 'allow', scope: 'once' }; },
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(callbackCalled).toBe(true);
    expect(result.allow).toBe(true);
  });

  it('sticky tier, callback allow once → allow, no persistence', async () => {
    const { bus, events } = makeBusRecorder();
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      projectDir,
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'allow', scope: 'once' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(events.some(e => e.type === 'approval_sticky_recorded')).toBe(false);
    const granted = events.find(e => e.type === 'approval_granted') as Extract<EngineEvent, { type: 'approval_granted' }> | undefined;
    expect(granted?.scope).toBe('once');
  });

  it('sticky tier, callback allow session → allow, persist, approval_sticky_recorded emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      projectDir,
      sessionId: 'sess-001',
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'allow', scope: 'session' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(events.some(e => e.type === 'approval_sticky_recorded')).toBe(true);
    const stored = JSON.parse(readFileSync(approvalsFile(projectDir), 'utf-8'));
    expect(stored.grants).toHaveLength(1);
    expect(stored.grants[0].scope).toBe('session');
    expect(stored.grants[0].sessionId).toBe('sess-001');
  });

  it('sticky tier, callback deny → deny, approval_rejected emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      projectDir,
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'deny', reason: 'wrong dir' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('wrong dir');
    const rejected = events.find(e => e.type === 'approval_rejected') as Extract<EngineEvent, { type: 'approval_rejected' }> | undefined;
    expect(rejected?.reason).toBe('wrong dir');
  });

  it('confirm tier, headless → deny APPROVAL_REQUIRED', async () => {
    const { bus } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true, headless: true, tiers: { destructive: 'confirm' } });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'rm -rf /tmp/foo',
    });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('APPROVAL_REQUIRED');
  });

  it('confirm tier, valid phrase + reason → allow, approval_granted emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'rm -rf /tmp/foo',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'confirm', phrase: 'I confirm', reason: 'I understand this is destructive' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    const granted = events.find(e => e.type === 'approval_granted') as Extract<EngineEvent, { type: 'approval_granted' }> | undefined;
    expect(granted).toBeDefined();
    expect(granted?.scope).toBe('once');
  });

  it('confirm tier, wrong phrase → deny invalid_confirm_phrase', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'rm -rf /tmp/foo',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'confirm', phrase: 'yes please', reason: 'I understand' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('invalid_confirm_phrase');
    const rejected = events.find(e => e.type === 'approval_rejected') as Extract<EngineEvent, { type: 'approval_rejected' }> | undefined;
    expect(rejected?.reason).toBe('invalid_confirm_phrase');
  });

  it('confirm tier, callback deny → deny, approval_rejected emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'rm -rf /tmp/foo',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'deny', reason: 'not allowed' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('not allowed');
    const rejected = events.find(e => e.type === 'approval_rejected') as Extract<EngineEvent, { type: 'approval_rejected' }> | undefined;
    expect(rejected?.reason).toBe('not allowed');
  });

  it('tier override write_out_of_scope → confirm', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true, tiers: { write_out_of_scope: 'confirm' } });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'confirm', phrase: 'I confirm', reason: 'I understand' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    const prompted = events.find(e => e.type === 'approval_prompted') as Extract<EngineEvent, { type: 'approval_prompted' }> | undefined;
    expect(prompted?.tier).toBe('confirm');
  });

  it('confirm tier, callback returns decision:allow → reject invalid_confirm_response', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'rm -rf /tmp/foo',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'allow', scope: 'once' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('invalid_confirm_response');
    const rejected = events.find(e => e.type === 'approval_rejected') as Extract<EngineEvent, { type: 'approval_rejected' }> | undefined;
    expect(rejected?.reason).toBe('invalid_confirm_response');
    const granted = events.find(e => e.type === 'approval_granted');
    expect(granted).toBeUndefined();
  });

  it('confirm tier, valid confirm → approval_granted event records confirmReason', async () => {
    const { bus, events } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      actionDescription: 'rm -rf /tmp/foo',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'confirm', phrase: 'I confirm', reason: 'cleaning stale fixtures' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(result.confirmReason).toBe('cleaning stale fixtures');
    const granted = events.find(e => e.type === 'approval_granted') as Extract<EngineEvent, { type: 'approval_granted' }> | undefined;
    expect(granted).toBeDefined();
    expect(granted?.confirmReason).toBe('cleaning stale fixtures');
  });

  it('sticky tier, session grant matches a different action description on same file (pattern match)', async () => {
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });

    const store = {
      version: 1,
      grants: [
        { pattern: '/tmp/outside-project/file.ts', class: 'write_out_of_scope', scope: 'session', sessionId: 'sess-X', grantedAt: new Date().toISOString() },
      ],
    };
    writeFileSync(approvalsFile(projectDir), JSON.stringify(store));

    const { bus, events } = makeBusRecorder();
    let prompted = false;
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      projectDir,
      sessionId: 'sess-X',
      actionDescription: 'modify /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => {
          prompted = true;
          return { decision: 'deny', reason: 'should not be called' };
        },
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const result = await gateAction(input);
    expect(result.allow).toBe(true);
    expect(prompted).toBe(false);
    const granted = events.find(e => e.type === 'approval_granted') as Extract<EngineEvent, { type: 'approval_granted' }> | undefined;
    expect(granted?.scope).toBe('session');
  });

  it('sticky tier, session grant is replaced when same pattern already has a session grant for a different session', async () => {
    const projectDir = createTempDir('diptych-test');
    mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });

    const store = {
      version: 1,
      grants: [
        { pattern: '/tmp/outside-project/file.ts', class: 'write_out_of_scope', scope: 'session', sessionId: 'sess-OLD', grantedAt: new Date().toISOString() },
        { pattern: '/tmp/other/file.ts', class: 'write_out_of_scope', scope: 'always', grantedAt: new Date().toISOString() },
      ],
    };
    writeFileSync(approvalsFile(projectDir), JSON.stringify(store));

    const { bus } = makeBusRecorder();
    const config = makeApprovalConfig({ enabled: true });
    const input = makeInput({
      bus,
      config,
      projectDir,
      sessionId: 'sess-NEW',
      actionDescription: 'write /tmp/outside-project/file.ts',
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
  
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({ decision: 'allow', scope: 'session' }),
      },
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    await gateAction(input);

    const updated = JSON.parse(readFileSync(approvalsFile(projectDir), 'utf-8'));
    const alwaysGrant = updated.grants.find((g: { pattern: string; scope: string }) => g.pattern === '/tmp/other/file.ts' && g.scope === 'always');
    expect(alwaysGrant).toBeDefined();
    const sessionGrants = updated.grants.filter((g: { pattern: string; scope: string }) => g.pattern === '/tmp/outside-project/file.ts' && g.scope === 'session');
    expect(sessionGrants).toHaveLength(1);
    expect(sessionGrants[0].sessionId).toBe('sess-NEW');
  });
});
