import { describe, expect, it } from 'vitest';
import type {
  FrozenPricing,
  RecoveryBudgetResource,
  RecoveryUsage,
} from '../schemas/brief-recovery/budget.js';
import type { TaskCompilationOperationEnvelope } from '../schemas/task-compilation.js';
import {
  persistRecoveryBudgetResource,
  readRecoveryBudgetResources,
  readRecoveryJournal,
} from './recovery-journal.js';
import { setupEvidenceTmpDir } from '#testing/helpers/evidence-test-setup.js';

const tmpDir = setupEvidenceTmpDir();

const ref = () => ({ projectDir: tmpDir.get(), sessionId: 'sess-pd' });

const usage: RecoveryUsage = {
  inputTokens: 100,
  outputTokens: 100,
  totalTokens: 200,
  estimated: false,
};

const resolvedPricing: FrozenPricing = {
  budgetUnit: 'usd',
  pricingIdentity: 'openai/gpt-5.4',
  inputPer1M: 2.5,
  outputPer1M: 15,
};

function boundedEnvelope(): TaskCompilationOperationEnvelope {
  return {
    version: 1,
    dispatchLimit: 64,
    callCount: 1,
    totalPromptBytes: 1_000,
    totalInputTokensUpperBound: 8_000,
    totalOutputTokensUpperBound: 8_192,
    totalNormalizedOutputBytes: 96 * 1_024,
    totalDeclaredArtifactBytes: 96 * 1_024,
    callsDigest: 'calls'.padEnd(64, '0'),
  };
}

function providerDependentResource(
  input: {
    accountingKey?: string | undefined;
    observedUsage?: RecoveryUsage | null | undefined;
    resolvedPricing?: FrozenPricing | null | undefined;
  } = {},
): RecoveryBudgetResource {
  return {
    kind: 'provider-dependent',
    accountingKey: input.accountingKey ?? 'session-1/epoch-1/operation-pd',
    pricingIdentity: 'opencode/auto',
    envelope: boundedEnvelope(),
    observedUsage: input.observedUsage ?? null,
    resolvedPricing: input.resolvedPricing ?? null,
  };
}

describe('provider-dependent recovery budget resources', () => {
  it('persists a hold and reads it back without fabricating USD', () => {
    const resource = providerDependentResource();
    const written = persistRecoveryBudgetResource(ref(), {
      epochId: 'epoch-1',
      operationId: 'operation-pd',
      kind: 'reservation',
      resource,
    });
    expect(written.record.kind).toBe('reservation');

    const read = readRecoveryBudgetResources(ref(), 'epoch-1', 'operation-pd');
    expect(read).toHaveLength(1);
    expect(read[0]?.recordHash).toBe(written.record.recordHash);
    expect(read[0]?.resource).toEqual(resource);
    expect(read[0]?.resource).not.toHaveProperty('amount');
  });

  it('reconciles observed usage against the same accounting key', () => {
    const hold = persistRecoveryBudgetResource(ref(), {
      epochId: 'epoch-1',
      operationId: 'operation-usage',
      kind: 'reservation',
      resource: providerDependentResource(),
    });
    const reconciled = persistRecoveryBudgetResource(ref(), {
      epochId: 'epoch-1',
      operationId: 'operation-usage',
      kind: 'usage-reconciliation',
      resource: providerDependentResource({ observedUsage: usage }),
    });

    const read = readRecoveryBudgetResources(ref(), 'epoch-1', 'operation-usage');
    expect(read.map((record) => record.kind)).toEqual(['reservation', 'usage-reconciliation']);
    expect(read[0]?.recordHash).toBe(hold.record.recordHash);
    expect(read[1]?.recordHash).toBe(reconciled.record.recordHash);
    expect(read[1]?.resource).toMatchObject({ observedUsage: usage, resolvedPricing: null });
  });

  it('keeps unknown-price distinct from unknown-dispatch holds', () => {
    const hold = persistRecoveryBudgetResource(ref(), {
      epochId: 'epoch-1',
      operationId: 'operation-distinct',
      kind: 'reservation',
      resource: providerDependentResource(),
    });
    const observedWrite = persistRecoveryBudgetResource(ref(), {
      epochId: 'epoch-1',
      operationId: 'operation-distinct',
      kind: 'usage-reconciliation',
      resource: providerDependentResource({ observedUsage: usage }),
    });

    const read = readRecoveryBudgetResources(ref(), 'epoch-1', 'operation-distinct');
    expect(read.find((record) => record.kind === 'reservation')?.recordHash).toBe(
      hold.record.recordHash,
    );
    expect(read.find((record) => record.kind === 'usage-reconciliation')?.recordHash).toBe(
      observedWrite.record.recordHash,
    );
  });

  it('persists a later-resolved price against the same accounting key', () => {
    const resource = providerDependentResource({
      accountingKey: 'session-1/epoch-1/operation-resolved',
      observedUsage: usage,
      resolvedPricing,
    });
    persistRecoveryBudgetResource(ref(), {
      epochId: 'epoch-1',
      operationId: 'operation-resolved',
      kind: 'usage-reconciliation',
      resource,
    });

    const read = readRecoveryBudgetResources(ref(), 'epoch-1', 'operation-resolved');
    expect(read).toHaveLength(1);
    expect(read[0]?.resource).toMatchObject({
      accountingKey: 'session-1/epoch-1/operation-resolved',
      observedUsage: usage,
      resolvedPricing,
    });
  });

  it('replays the same write idempotently without journal growth', () => {
    const input = {
      epochId: 'epoch-1',
      operationId: 'operation-replay',
      kind: 'reservation' as const,
      resource: providerDependentResource(),
    };
    const first = persistRecoveryBudgetResource(ref(), input);
    const replayed = persistRecoveryBudgetResource(ref(), input);
    expect(replayed.record).toEqual(first.record);
    expect(readRecoveryJournal(ref()).records).toHaveLength(1);
    expect(readRecoveryBudgetResources(ref(), 'epoch-1', 'operation-replay')).toHaveLength(1);
  });

  it('never accepts a finite USD resource or a fabricated zero amount', () => {
    const finite: RecoveryBudgetResource = {
      kind: 'finite-usd',
      accountingKey: 'session-1/epoch-1/operation-finite',
      amount: 0.2,
      envelope: boundedEnvelope(),
      pricing: resolvedPricing,
    };
    expect(() =>
      persistRecoveryBudgetResource(ref(), {
        epochId: 'epoch-1',
        operationId: 'operation-finite',
        kind: 'reservation',
        resource: finite,
      }),
    ).toThrow('provider-dependent without USD');

    expect(() =>
      persistRecoveryBudgetResource(ref(), {
        epochId: 'epoch-1',
        operationId: 'operation-zero',
        kind: 'reservation',
        resource: Object.assign(providerDependentResource(), {
          accountingKey: 'session-1/epoch-1/operation-zero',
          amount: 0,
        }),
      }),
    ).toThrow('payload is invalid');
  });

  it('rejects inconsistent resource states for the record kind', () => {
    expect(() =>
      persistRecoveryBudgetResource(ref(), {
        epochId: 'epoch-1',
        operationId: 'operation-bad-hold',
        kind: 'reservation',
        resource: providerDependentResource({ observedUsage: usage }),
      }),
    ).toThrow('cannot carry observed usage or resolved pricing');

    expect(() =>
      persistRecoveryBudgetResource(ref(), {
        epochId: 'epoch-1',
        operationId: 'operation-bad-reconcile',
        kind: 'usage-reconciliation',
        resource: providerDependentResource(),
      }),
    ).toThrow('must observe usage or resolve pricing');
  });
});
