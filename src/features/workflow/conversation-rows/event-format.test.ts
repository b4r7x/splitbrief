import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import {
  baselineValidationRow,
  formatExternalChangesValue,
  formatTaskStartedValue,
  validationStageNotes,
  validationSummarySegments,
} from './event-format.js';

function validateEvent(
  overrides: Partial<Extract<EngineEvent, { type: 'validate' }>>,
): Extract<EngineEvent, { type: 'validate' }> {
  return {
    type: 'validate',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    status: 'done',
    passed: true,
    stages: { typecheck: true, lint: true, test: true },
    ...overrides,
  };
}

function summaryText(event: Extract<EngineEvent, { type: 'validate' }>): string {
  return validationSummarySegments(event)
    .map((segment) => segment.text)
    .join('');
}

function stageTone(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stage: string,
): string | undefined {
  return validationSummarySegments(event).find((segment) => segment.text.endsWith(` ${stage}`))
    ?.tone;
}

describe('validationSummarySegments', () => {
  it('tones a passing stage apart from a stage that never ran', () => {
    const event = validateEvent({ stages: { typecheck: true, lint: false, test: false } });

    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'lint')).toBe('textDim');
    expect(stageTone(event, 'test')).toBe('textDim');
  });

  it('tones a failed stage apart from a stage that never ran', () => {
    const event = validateEvent({
      passed: false,
      stages: { typecheck: true, lint: false, test: false },
      attempted: { typecheck: true, lint: true, test: false },
    });

    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'lint')).toBe('error');
    expect(stageTone(event, 'test')).toBe('textDim');
  });

  it('tones a skipped stage as neither passed nor failed', () => {
    const event = validateEvent({
      passed: false,
      stages: { typecheck: true, lint: false, test: true },
      skipped: { lint: true },
    });

    expect(stageTone(event, 'lint')).toBe('textDim');
    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'test')).toBe('success');
  });

  it('tones the running stage distinctly', () => {
    const event = validateEvent({
      status: 'running',
      stages: { typecheck: false, lint: false, test: false },
      activeStage: 'typecheck',
      commands: { typecheck: 'npm run typecheck' },
    });

    expect(stageTone(event, 'typecheck')).toBe('info');
    expect(stageTone(event, 'lint')).toBe('textDim');
  });

  // Commands are what made this row wrap mid-stage; they live on the error block below it now.
  it('omits stage commands so the row stays on one line', () => {
    const text = summaryText(
      validateEvent({
        passed: false,
        stages: { typecheck: true, lint: false, test: false },
        attempted: { typecheck: true, lint: true, test: false },
        commands: { typecheck: 'npx tsc --noEmit', lint: 'npm run lint' },
      }),
    );

    expect(text).not.toContain('npm run lint');
    expect(text).not.toContain('npx tsc --noEmit');
    expect(getTerminalCellWidth(text)).toBeLessThan(60);
  });

  it('tones a baseline-exempt failure apart from a failure this task caused', () => {
    const event = validateEvent({
      exempt: true,
      stages: { typecheck: true, lint: false, test: true },
      attempted: { typecheck: true, lint: true, test: true },
    });

    expect(stageTone(event, 'lint')).toBe('warning');
    expect(stageTone(event, 'typecheck')).toBe('success');
  });
});

describe('validationStageNotes', () => {
  it('names the reason a stage was skipped, the way the evidence ledger does', () => {
    expect(
      validationStageNotes(
        validateEvent({
          stages: { typecheck: true, lint: true, test: false },
          skipped: { test: true },
          skippedReason: { test: 'no affected test file found' },
        }),
      ),
    ).toEqual(['test skipped (no affected test file found)']);
  });

  it('states a skip with no recorded reason without an empty bracket', () => {
    expect(
      validationStageNotes(
        validateEvent({
          stages: { typecheck: true, lint: true, test: false },
          skipped: { test: true },
        }),
      ),
    ).toEqual(['test skipped']);
  });

  it('names a baseline-exempt failure so the accepted run does not read as a green one', () => {
    expect(
      validationStageNotes(
        validateEvent({
          exempt: true,
          stages: { typecheck: true, lint: false, test: false },
          attempted: { typecheck: true, lint: true, test: true },
          skipped: { test: true },
          skippedReason: { test: 'no affected test file found' },
        }),
      ),
    ).toEqual(['lint pre-existing failure', 'test skipped (no affected test file found)']);
  });

  it('says nothing when every stage ran and passed', () => {
    expect(validationStageNotes(validateEvent({}))).toEqual([]);
  });
});

function baselineEvent(
  overrides: Partial<Extract<EngineEvent, { type: 'validation_baseline' }>>,
): Extract<EngineEvent, { type: 'validation_baseline' }> {
  return {
    type: 'validation_baseline',
    ts: 0,
    phase: 'implementing',
    status: 'done',
    stages: { typecheck: true, lint: true, test: true },
    ...overrides,
  };
}

describe('baselineValidationRow', () => {
  it('renders passed, failed, and not-run baseline stages as distinct states', () => {
    const row = baselineValidationRow(
      baselineEvent({
        stages: { typecheck: true, lint: false, test: false },
        failing: { lint: true },
      }),
    );

    expect(row).toContain('typecheck passed');
    expect(row).toContain('lint failed');
    expect(row).toContain('test not-run');
    expect(row).not.toContain('lint passed');
    expect(row).not.toContain('lint not-run');
  });

  it('renders the active stage while the baseline probe is running', () => {
    const row = baselineValidationRow(
      baselineEvent({
        status: 'running',
        stages: { typecheck: true, lint: false, test: false },
        activeStage: 'lint',
        commands: { lint: 'cargo clippy --no-deps' },
      }),
    );

    expect(row).toContain('lint (cargo clippy --no-deps) running');
    expect(row).toContain('typecheck passed');
    expect(row).toContain('test not-run');
  });
});

function taskStartedEvent(
  overrides: Partial<Extract<EngineEvent, { type: 'task_started' }>>,
): Extract<EngineEvent, { type: 'task_started' }> {
  return {
    type: 'task_started',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add the validator',
    index: 0,
    total: 1,
    file: 'src/validate.ts',
    action: 'create',
    tool: 'claude-code',
    model: 'opus',
    ...overrides,
  };
}

describe('formatTaskStartedValue', () => {
  it('names the build seat in the words the seat identity uses for it', () => {
    expect(formatTaskStartedValue(taskStartedEvent({}))).toBe(
      'src/validate.ts (create) · Claude Code CLI · Opus 5.5',
    );
  });

  // Run 3's T001 row read `profile default · fit fits · why Selected profile default (fits,
  // estimated 5075/1000000 tokens)`: the routing sentence repeated the two facts before it.
  it('names the worker once and says nothing more about a brief that fits', () => {
    const value = formatTaskStartedValue(
      taskStartedEvent({
        file: 'testing/fixtures/opencode/api-model-full.json',
        action: 'modify',
        implementerProfile: 'default',
        contextFit: 'fits',
        estimatedTokens: 5075,
        contextLength: 1_000_000,
        routingReason: 'Selected profile default (fits, estimated 5075/1000000 tokens)',
      }),
    );

    expect(value).toBe(
      'testing/fixtures/opencode/api-model-full.json (modify) · Claude Code CLI · Opus 5.5 · worker default',
    );
    expect(value).not.toContain('fit fits');
    expect(value).not.toContain('Selected profile');
  });

  it('gives a tight brief its estimate against the context window', () => {
    const value = formatTaskStartedValue(
      taskStartedEvent({
        implementerProfile: 'default',
        contextFit: 'tight',
        estimatedTokens: 24_310,
        contextLength: 32_768,
        routingReason: 'Selected profile default (tight, estimated 24310/32768 tokens)',
      }),
    );

    expect(value).toBe(
      'src/validate.ts (create) · Claude Code CLI · Opus 5.5 · worker default · ~24,310 of 32K context tokens (tight)',
    );
  });

  it('keeps the estimate when the context window is unknown', () => {
    const value = formatTaskStartedValue(
      taskStartedEvent({ contextFit: 'overflow', estimatedTokens: 41_200 }),
    );

    expect(value).toBe(
      'src/validate.ts (create) · Claude Code CLI · Opus 5.5 · ~41,200 context tokens (overflow)',
    );
  });
});

type ExternalChangesEvent = Extract<EngineEvent, { type: 'paused_external_changes' }>;
type ExternalConflict = NonNullable<ExternalChangesEvent['conflict']>;

function externalChanges(
  conflict: Pick<ExternalConflict, 'kind' | 'files' | 'fileConflicts'> | undefined,
  selectedAction?: ExternalChangesEvent['selectedAction'],
): ExternalChangesEvent {
  const affectedTaskIds = [
    ...new Set(conflict?.fileConflicts.flatMap((file) => file.affectedTaskIds)),
  ].sort();
  return {
    type: 'paused_external_changes',
    ts: 0,
    phase: 'implementing',
    ...(conflict !== undefined && {
      conflict: {
        ...conflict,
        affectedTaskIds,
        currentTaskId: taskId('T002'),
        safeToContinue:
          conflict.kind === 'unrelated' || conflict.kind === 'future-task-stale-input',
        availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
      },
    }),
    ...(selectedAction !== undefined && { selectedAction }),
  };
}

function fileConflict(
  file: string,
  kind: ExternalConflict['kind'],
  ...briefs: string[]
): ExternalConflict['fileConflicts'][number] {
  return { file, kind, affectedTaskIds: briefs.map((brief) => taskId(brief)) };
}

describe('formatExternalChangesValue', () => {
  // Run 3's continue: 128 files other agents edited, none of them declared by the brief left, and
  // the card read `unrelated · CHANGELOG.md · … · +125 more · continue-unrelated`.
  it('says where the edits sit and what the run did, in words', () => {
    const files = [
      'CHANGELOG.md',
      'docs/CLI-REFERENCE.md',
      'docs/ENGINE.md',
      ...Array.from({ length: 125 }, (_, index) => `src/edited-${index}.ts`),
    ];
    const value = formatExternalChangesValue(
      externalChanges(
        {
          kind: 'unrelated',
          files,
          fileConflicts: files.map((file) => fileConflict(file, 'unrelated')),
        },
        'continue-unrelated',
      ),
    );

    expect(value).toBe(
      'outside the remaining briefs · run continued\nCHANGELOG.md · docs/CLI-REFERENCE.md · docs/ENGINE.md · +125 more',
    );
    expect(value).not.toContain('continue-unrelated');
    expect(value).not.toMatch(/^unrelated\b/);
  });

  it.each([
    {
      kind: 'future-task-stale-input',
      brief: 'T003',
      action: 'continue-unrelated',
      expected: 'input to T003 · run continued\nsrc/shared.ts',
    },
    {
      kind: 'current-task-conflict',
      brief: 'T002',
      action: 'pause',
      expected: 'conflict with T002 · recovery needed\nsrc/shared.ts',
    },
    {
      kind: 'dependency-file-conflict',
      brief: 'T001',
      action: 'pause',
      expected: 'conflict with T002 · recovery needed\nsrc/shared.ts',
    },
    {
      kind: 'changed-during-approval-promotion',
      brief: 'T002',
      action: 'pause',
      expected: 'changed during the approval of T002 · recovery needed\nsrc/shared.ts',
    },
  ] as const)('words a $kind edit', ({ kind, brief, action, expected }) => {
    const value = formatExternalChangesValue(
      externalChanges(
        {
          kind,
          files: ['src/shared.ts'],
          fileConflicts: [fileConflict('src/shared.ts', kind, brief)],
        },
        action,
      ),
    );

    expect(value).toBe(expected);
  });

  it('names the brief the edits stop, not every brief they touch', () => {
    const value = formatExternalChangesValue(
      externalChanges(
        {
          kind: 'current-task-conflict',
          files: ['src/current.ts', 'src/future.ts'],
          fileConflicts: [
            fileConflict('src/current.ts', 'current-task-conflict', 'T002'),
            fileConflict('src/future.ts', 'future-task-stale-input', 'T003'),
          ],
        },
        'pause',
      ),
    );

    expect(value).toBe('conflict with T002 · recovery needed\nsrc/current.ts · src/future.ts');
  });

  it('does not leave a blank future brief in the user edits card', () => {
    const value = formatExternalChangesValue(
      externalChanges(
        { kind: 'future-task-stale-input', files: ['src/future.ts'], fileConflicts: [] },
        'continue-unrelated',
      ),
    );

    expect(value).toBe('input to a future brief · run continued\nsrc/future.ts');
  });

  // An answer other than continue raises a recovery issue; the card must not name an action the
  // recovery panel is about to offer as a choice.
  it('says a recovery is needed for every answer that did not continue the run', () => {
    for (const action of ['pause', 'skip-current-task', 'abort-workflow'] as const) {
      const value = formatExternalChangesValue(
        externalChanges(
          {
            kind: 'future-task-stale-input',
            files: ['src/future.ts'],
            fileConflicts: [fileConflict('src/future.ts', 'future-task-stale-input', 'T003')],
          },
          action,
        ),
      );

      expect(value).toBe('input to T003 · recovery needed\nsrc/future.ts');
    }
  });

  it('words the outcome of an event that names no conflict', () => {
    expect(formatExternalChangesValue(externalChanges(undefined, 'continue-unrelated'))).toBe(
      'External changes detected · run continued',
    );
    expect(formatExternalChangesValue(externalChanges(undefined))).toBe(
      'External changes detected',
    );
  });
});
