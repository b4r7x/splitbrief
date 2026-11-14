import { describe, expect, it } from 'vitest';
import { CREW_SEAT_LABELS } from '../../../../core/crew/identity.js';
import type { ModelCacheAccessor } from '../../../../engine/providers/model/runtime-snapshot.js';
import { runnerActivityLedgerItem } from './ledger-item.js';
import { runnerActivityRoleLabel } from './role.js';
import { resolveRunnerActivityModelNames, runnerActivityModelRole } from './role.js';

// A fallback warning row spells the catalog names of the raw ids its frame named, and keeps a
// raw id the catalog does not know. The message itself is the provider's own copy; only the
// ids inside it are rewritten, so the row never loses the sentence that said what happened.
describe('warning model id resolution', () => {
  const catalog: ModelCacheAccessor = {
    getModelsDevCatalog: () => null,
    getProviderModels: () => [
      { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      { id: 'claude-opus-5', displayName: 'Opus 5' },
      { id: 'claude-sonnet-5', displayName: 'Sonnet 5' },
    ],
  };

  const fallbackRow = {
    stage: 'warning',
    kind: 'warning',
    label: 'warning claude_fallback',
    diagnosticPartial: 'claude-opus-5-5 → claude-sonnet-5 (overloaded)',
    runnerName: 'claude',
    role: 'planner',
    backendKind: 'cli',
  } as const;

  it('spells catalog names for the ids the warning named', () => {
    const item = runnerActivityLedgerItem(
      { ...fallbackRow, originalModel: 'claude-opus-5-5', fallbackModel: 'claude-sonnet-5' },
      { cache: catalog },
    );

    expect(item?.value).toBe('Opus 5.5 → Sonnet 5 (overloaded)');
    expect(item?.diagnosticPreview).toBe('Opus 5.5 → Sonnet 5 (overloaded)');
  });

  it('spells an id no catalog knows as its pretty name beside the catalog names', () => {
    const item = runnerActivityLedgerItem(
      {
        ...fallbackRow,
        diagnosticPartial: 'claude-opus-5-5 → claude-zeta-9 (overloaded)',
        originalModel: 'claude-opus-5-5',
        fallbackModel: 'claude-zeta-9',
      },
      { cache: catalog },
    );

    expect(item?.value).toBe('Opus 5.5 → Claude Zeta 9 (overloaded)');
  });

  it('replaces the longest id first so a shorter sibling cannot rewrite part of it', () => {
    const resolved = resolveRunnerActivityModelNames(
      {
        ...fallbackRow,
        diagnosticPartial: 'claude-opus-5 → claude-opus-5-5',
        originalModel: 'claude-opus-5',
        fallbackModel: 'claude-opus-5-5',
      },
      catalog,
    );

    expect(resolved).toBe('Opus 5 → Opus 5.5');
  });

  it('leaves a row with no structured ids exactly as recorded', () => {
    const item = runnerActivityLedgerItem({ ...fallbackRow }, { cache: catalog });

    expect(item?.value).toBe('claude-opus-5-5 → claude-sonnet-5 (overloaded)');
    expect(resolveRunnerActivityModelNames({ ...fallbackRow }, catalog)).toBeNull();
  });

  it('spells an API call ids pretty, never with the CLI alias labels, when its runner name is a CLI tool id', () => {
    const item = runnerActivityLedgerItem(
      {
        ...fallbackRow,
        backendKind: 'api',
        runnerName: 'claude-code',
        originalModel: 'claude-opus-5-5',
        fallbackModel: 'claude-sonnet-5',
      },
      { cache: catalog },
    );

    expect(item?.value).toBe('Claude Opus 5.5 → Claude Sonnet 5 (overloaded)');
  });

  it('routes each seat role to the catalog that names its models', () => {
    expect(runnerActivityModelRole('planner')).toBe('planner');
    expect(runnerActivityModelRole('summary')).toBe('planner');
    expect(runnerActivityModelRole('compaction')).toBe('planner');
    expect(runnerActivityModelRole('escalation')).toBe('planner');
    expect(runnerActivityModelRole('implementer')).toBe('implementer');
    expect(runnerActivityModelRole('review')).toBe('reviewer');
  });
});

describe('runnerActivityRoleLabel', () => {
  it('returns seat constants for seat roles', () => {
    expect(runnerActivityRoleLabel('planner')).toBe(CREW_SEAT_LABELS.plan);
    expect(runnerActivityRoleLabel('implementer')).toBe(CREW_SEAT_LABELS.build);
    expect(runnerActivityRoleLabel('review')).toBe(CREW_SEAT_LABELS.review);
  });

  it('returns Title Case labels for non-seat roles', () => {
    expect(runnerActivityRoleLabel('summary')).toBe('Summary');
    expect(runnerActivityRoleLabel('compaction')).toBe('Compaction');
    expect(runnerActivityRoleLabel('escalation')).toBe('Escalation');
  });
});
