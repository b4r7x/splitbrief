import { describe, expect, it } from 'vitest';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import {
  cleanRunnerActivityText,
  resolveRunnerActivityModelNames,
  runnerActivityDiagnosticPreview,
  runnerActivityLedgerItem,
  runnerActivityModelRole,
  runnerActivityRoleLabel,
} from './runner-activity-display.js';

describe('runnerActivityLedgerItem', () => {
  it('hides internal interruption codes from compact activity', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'cancelled',
      }),
    ).toMatchObject({
      label: 'WARN',
      value: 'current turn interrupted: cancelled',
      diagnosticPreview: 'cancelled',
      tone: 'warning',
      valueTone: 'warning',
      severity: 'warning',
      pinned: true,
    });
  });

  it('prettifies recognized shell reads, searches, and listings out of RUN commands', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: "running sed -n '1,240p' CLAUDE.md",
        target: "sed -n '1,240p' CLAUDE.md",
      }),
    ).toMatchObject({ label: 'READ', value: 'CLAUDE.md :1-240', fitMode: 'start' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'unknown',
        label: '/bin/zsh -lc "rg -n deriveLiveStatus src"',
      }),
    ).toMatchObject({ label: 'FIND', value: '"deriveLiveStatus"  src' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running ls src/features',
        target: 'ls src/features',
      }),
    ).toMatchObject({ label: 'LIST', value: 'src/features', fitMode: 'start' });
  });

  it('keeps compound or unrecognized commands as raw RUN', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running cat a.ts && cat b.ts',
        target: 'cat a.ts && cat b.ts',
      }),
    ).toMatchObject({ label: 'RUN', value: 'cat a.ts && cat b.ts', fitMode: 'middle' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running wc -l CLAUDE.md',
        target: 'wc -l CLAUDE.md',
      }),
    ).toMatchObject({ label: 'RUN', value: 'wc -l CLAUDE.md' });
  });

  it('keeps real terminal failures distinct from interruption', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'timeout',
        kind: 'error',
        label: 'timeout command_timeout',
        diagnosticPartial: 'Command timed out',
      }),
    ).toMatchObject({
      label: 'ERR',
      value: 'command_timeout: Command timed out',
      diagnosticPreview: 'Command timed out',
      tone: 'error',
      valueTone: 'error',
      severity: 'error',
      pinned: true,
    });
  });
});

describe('runnerActivityDiagnosticPreview', () => {
  it('uses bounded sanitized diagnostics for warning and error activity', () => {
    const preview = runnerActivityDiagnosticPreview(
      {
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
        diagnosticPartial: 'stderr sk-abcdefghijklmnopqrstuvwxyz keeps going',
      },
      24,
    );

    expect(preview).toBe('stderr sk-***REDACTED**…');
  });

  it('falls back to textPartial when no diagnosticPartial is available', () => {
    expect(
      runnerActivityDiagnosticPreview({
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
        textPartial: 'stderr preview',
      }),
    ).toBe('stderr preview');
  });
});

describe('cleanRunnerActivityText', () => {
  it('sanitizes terminal controls, secrets, and internal runner interruption code', () => {
    expect(
      cleanRunnerActivityText(
        '\u001b[31mrunner_interrupted\u001b[0m sk-abcdefghijklmnopqrstuvwxyz',
      ),
    ).toBe('interrupted sk-***REDACTED***');
  });
});

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

    expect(item.value).toBe('claude_fallback: Opus 5.5 → Sonnet 5 (overloaded)');
    expect(item.diagnosticPreview).toBe('Opus 5.5 → Sonnet 5 (overloaded)');
  });

  it('keeps an unresolved raw id beside the names the catalog knows', () => {
    const item = runnerActivityLedgerItem(
      {
        ...fallbackRow,
        diagnosticPartial: 'claude-opus-5-5 → claude-zeta-9 (overloaded)',
        originalModel: 'claude-opus-5-5',
        fallbackModel: 'claude-zeta-9',
      },
      { cache: catalog },
    );

    expect(item.value).toBe('claude_fallback: Opus 5.5 → claude-zeta-9 (overloaded)');
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

    expect(item.value).toBe('claude_fallback: claude-opus-5-5 → claude-sonnet-5 (overloaded)');
    expect(resolveRunnerActivityModelNames({ ...fallbackRow }, catalog)).toBeNull();
  });

  it('keeps raw ids on an API call whose runner name is a CLI tool id', () => {
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

    expect(item.value).toBe('claude_fallback: claude-opus-5-5 → claude-sonnet-5 (overloaded)');
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
