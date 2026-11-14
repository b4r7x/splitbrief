import { afterEach, describe, expect, it } from 'vitest';
import { segmentText } from '#testing/helpers/segment-text.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { modelCacheStore } from '../../../../stores/discovery/model-cache/state.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import {
  formatTaskStartedParts,
  reviewChecksSegments,
  reviewNoneSegments,
  validationStageNotes,
  validationSummarySegments,
} from './format.js';

function reviewChecksRow(event: Extract<EngineEvent, { type: 'review_checks' }>): string {
  return segmentText(reviewChecksSegments(event));
}

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
  const segments = validationSummarySegments(event);
  const index = segments.findIndex((segment) => segment.text === ` ${stage}`);
  expect(segments[index]?.tone).toBe('textDim');
  return segments[index - 1]?.tone;
}

describe('validationSummarySegments', () => {
  it('colors an interrupted older gate as attention with a dim label and separator', () => {
    const event = validateEvent({ status: 'stopped', activeStage: 'test', passed: false });
    expect(validationSummarySegments(event)).toEqual([
      { text: 'Validate', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'stopped', tone: 'warning' },
    ]);
  });
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

    expect(stageTone(event, 'typecheck')).toBe('accent');
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

describe('reviewChecksRow', () => {
  it('says once, as a warning, that no reviewer check ran when End-of-run checks are off', () => {
    const event = { type: 'review_checks', ts: 0, phase: 'final-review', status: 'off' } as const;
    expect(reviewChecksRow(event)).toBe('End-of-run checks · off · no reviewer check ran');
    expect(reviewChecksSegments(event)).toContainEqual({ text: 'off', tone: 'warning' });
  });

  it('says, in the dim tone, that the plan names no project gate', () => {
    const event = { type: 'review_checks', ts: 0, phase: 'final-review', status: 'none' } as const;
    expect(reviewChecksRow(event)).toBe(
      'End-of-run checks · none · the plan names no project gate',
    );
    expect(reviewChecksSegments(event)).toEqual([
      { text: 'End-of-run checks', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'none', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'the plan names no project gate', tone: 'textDim' },
    ]);
  });
});

describe('reviewNoneSegments', () => {
  it('fits the REVIEW None row in 60 cells', () => {
    const text = segmentText(reviewNoneSegments());
    expect(text).toBe('Review · none · no seat reviewed this run');
    expect(getTerminalCellWidth(text)).toBeLessThanOrEqual(60);
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

function taskStartedPartTexts(event: Extract<EngineEvent, { type: 'task_started' }>): string[] {
  return formatTaskStartedParts(event).map((part) => part.text);
}

describe('formatTaskStartedParts', () => {
  it('carries identity and metadata boundaries as tones', () => {
    expect(formatTaskStartedParts(taskStartedEvent({}))).toEqual([
      { text: 'src/validate.ts (create)', tone: 'textDim' },
      { text: 'Claude Code CLI · Opus 5.5', tone: 'implementer' },
    ]);
  });
  afterEach(() => modelCacheStore.reset());

  it.each(['default', 'local-fixture'])(
    'shows the recorded seat without a worker-profile suffix',
    (implementerProfile) => {
      modelCacheStore.hydrateDetection({
        providers: [],
        cliTools: [],
        fetchedAt: 0,
        validatedAt: 0,
        generation: 1,
        requestId: 1,
        contexts: {
          readiness: 'task-row-readiness',
          modelsDev: 'task-row-models-dev',
          cliModels: 'task-row-cli-models',
        },
        cliCatalogs: [
          {
            tool: 'opencode',
            models: [{ id: 'opencode-go/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' }],
            probedAt: 0,
          },
        ],
      });
      const parts = taskStartedPartTexts(
        taskStartedEvent({
          file: 'src/text.js',
          action: 'modify',
          tool: 'opencode',
          model: 'opencode-go/deepseek-v4.1-flash',
          axes: ['high'],
          backendKind: 'cli',
          implementerProfile,
        }),
      );

      expect(parts).toEqual([
        'src/text.js (modify)',
        'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
      ]);
    },
  );

  it.each([
    ['shell', 'Custom Shell'],
    ['agent', 'Agent'],
  ] as const)('names a recorded %s build seat consistently', (backendKind, label) => {
    expect(
      taskStartedPartTexts(taskStartedEvent({ tool: backendKind, model: 'gpt-5', backendKind })),
    ).toEqual(['src/validate.ts (create)', `${label} · GPT-5`]);
    for (const command of ['claude', 'opencode']) {
      expect(
        taskStartedPartTexts(taskStartedEvent({ tool: command, model: 'gpt-5', backendKind })),
      ).toEqual(['src/validate.ts (create)', `${label} · GPT-5`]);
    }
  });

  it('resolves an older CLI command through the same model catalog as a current call', () => {
    expect(taskStartedPartTexts(taskStartedEvent({ tool: 'claude', model: 'sonnet' }))).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Sonnet 5.5',
    ]);
  });

  it('keeps the recorded build axes and backend when the runner name matches a CLI command', () => {
    expect(
      taskStartedPartTexts(
        taskStartedEvent({ tool: 'codex', model: 'gpt-5', axes: ['high'], backendKind: 'cli' }),
      ),
    ).toEqual(['src/validate.ts (create)', 'OpenAI Codex CLI · GPT-5 · high']);
    expect(
      taskStartedPartTexts(
        taskStartedEvent({ tool: 'claude', model: undefined, axes: [], backendKind: 'shell' }),
      ),
    ).toEqual(['src/validate.ts (create)', 'Custom Shell · auto']);
  });

  it('names the build seat in the words the seat identity uses for it', () => {
    expect(taskStartedPartTexts(taskStartedEvent({}))).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Opus 5.5',
    ]);
  });

  // Run 3's T001 row read `profile default · fit fits · why Selected profile default (fits,
  // estimated 5075/1000000 tokens)`: the routing sentence repeated the two facts before it.
  it('says nothing more about a brief that fits', () => {
    const parts = taskStartedPartTexts(
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

    expect(parts).toEqual([
      'testing/fixtures/opencode/api-model-full.json (modify)',
      'Claude Code CLI · Opus 5.5',
    ]);
    for (const part of parts) {
      expect(part).not.toContain('fit fits');
      expect(part).not.toContain('Selected profile');
    }
  });

  it('gives a tight brief its estimate against the context window', () => {
    const parts = taskStartedPartTexts(
      taskStartedEvent({
        implementerProfile: 'default',
        contextFit: 'tight',
        estimatedTokens: 24_310,
        contextLength: 32_768,
        routingReason: 'Selected profile default (tight, estimated 24310/32768 tokens)',
      }),
    );

    expect(parts).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Opus 5.5',
      '~24,310 of 32K context tokens (tight)',
    ]);
  });

  it('shows only the estimate for a brief over its window', () => {
    const parts = taskStartedPartTexts(
      taskStartedEvent({ contextFit: 'overflow', estimatedTokens: 31_012, contextLength: 32_768 }),
    );

    expect(parts).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Opus 5.5',
      '~31,012 context tokens',
    ]);
  });

  it('keeps the estimate when the context window is unknown', () => {
    const parts = taskStartedPartTexts(
      taskStartedEvent({ contextFit: 'tight', estimatedTokens: 41_200 }),
    );

    expect(parts).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Opus 5.5',
      '~41,200 context tokens (tight)',
    ]);
  });
});
