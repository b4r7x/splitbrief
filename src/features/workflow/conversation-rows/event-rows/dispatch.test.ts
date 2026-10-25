import { describe, expect, it, vi } from 'vitest';
import { CREW_SEAT_LABELS, formatSeatCandidateIdentity } from '../../../../core/crew/identity.js';
import { taskId } from '../../../../core/schemas/task.js';
import { arrowSep } from '../../../../core/separators.js';
import type { DriftFinding } from '../../../../core/schemas/drift.js';
import type { ClarificationQuestion } from '../../../../core/schemas/question.js';
import { parseEngineEvent } from '../../../../engine/events/schema.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { glyph } from '../../../../lib/glyphs.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import {
  makeRunnerCallCompleted,
  makeRunnerCallError,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../../display/activity-label-display.js';
import { configStore } from '../../../../stores/project/config.js';
import { eventRowBlock, recoveryRowBlock } from './dispatch.js';
import { rowText } from '../row-format/rows.js';
import { rowLeadingCells } from '../row-markers.js';
import type { ConversationRow } from '../types.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

it.each([60, 120])('shows the repaired plan pass through the transcript at %i columns', (width) => {
  const rows = eventRows({
    event: {
      type: 'info',
      ts: 0,
      phase: 'planning',
      message: 'The revised plan passes its checks.',
    },
    globalIndex: 0,
    expanded: false,
    ctx: { width, viewportRows: 24, streaming },
  });
  expect(rows.map(rowText)).toEqual(['SPLITBRIEF  The revised plan passes its checks.']);
});

it('moves the whole destination identity after the arrow at 80 columns', () => {
  const rows = eventRows({
    event: {
      type: 'seat_switched',
      ts: 0,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'revision',
    },
    globalIndex: 0,
    expanded: false,
    causeInRecovery: true,
    ctx: { width: 80, viewportRows: 24, streaming },
  });
  expect(rows.map(rowText)).toEqual([
    'BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
    `${glyph('connectorHandoff')} OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high`,
    'automatic fallback',
  ]);
});

it.each([
  [62, ['via opencode-go', 'high · automatic fallback']],
  [63, ['via opencode-go', 'high · automatic fallback']],
  [64, ['via opencode-go', 'high · automatic fallback']],
  [65, ['via opencode-go · high', 'automatic fallback']],
])('keeps the arrow with the destination identity at %i columns', (width, [end, last]) => {
  const rows = eventRows({
    event: {
      type: 'seat_switched',
      ts: 0,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'revision',
    },
    globalIndex: 0,
    expanded: false,
    causeInRecovery: true,
    ctx: { width, viewportRows: 24, streaming },
  });
  expect(rows.map(rowText)).toEqual([
    'BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
    `${glyph('connectorHandoff')} OpenCode CLI · DeepSeek V4.1 Flash · ${end}`,
    last,
  ]);
});

it.each([
  [
    55,
    { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
    [
      'BUILD  OpenCode CLI · DeepSeek V4.1 Flash',
      'via deepseek',
      `${glyph('connectorHandoff')} OpenCode CLI · DeepSeek V4.1 Flash`,
      'via opencode-go · high · automatic fallback',
    ],
  ],
  [
    34,
    { tool: 'codex', model: 'gpt-5-codex' },
    { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    [
      'BUILD  OpenAI Codex CLI',
      'GPT-5 Codex',
      `${glyph('connectorHandoff')} OpenAI Codex CLI`,
      'GPT-6.1-Sol · high',
      'automatic fallback',
    ],
  ],
] as const)('starts the destination on its own row at %i columns', (width, from, to, expected) => {
  const rows = eventRows({
    event: {
      type: 'seat_switched',
      ts: 0,
      phase: 'implementing',
      seat: 'build',
      from,
      to,
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'revision',
    },
    globalIndex: 0,
    expanded: false,
    causeInRecovery: true,
    ctx: { width, viewportRows: 24, streaming },
  });
  expect(rows.map(rowText)).toEqual(expected);
});

it.each([true, false])('names both same-name switch endpoints with auto=%s', (auto) => {
  const rows = eventRows({
    event: {
      type: 'seat_switched',
      ts: 0,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      cause: 'runner-usage-limit',
      auto,
      configRevision: 'revision',
    },
    globalIndex: 0,
    expanded: false,
    ctx: { width: 200, viewportRows: 40, streaming },
  });
  const text = rows.map(rowText).join('\n');
  expect(text).toContain(
    `BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek ${glyph('connectorHandoff')} OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high`,
  );
  expect(text.includes('automatic fallback')).toBe(auto);
});

it('keeps different catalog words on both switch endpoints', () => {
  const rows = eventRows({
    event: {
      type: 'seat_switched',
      ts: 0,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'claude-code', model: 'claude-sonnet-4' },
      to: { tool: 'claude-code', model: 'claude-opus-4' },
      cause: 'runner-usage-limit',
      auto: false,
      configRevision: 'revision',
    },
    globalIndex: 0,
    expanded: false,
    ctx: { width: 200, viewportRows: 40, streaming },
  });
  expect(rows.map(rowText).join('\n')).toContain(
    `Claude Code CLI · Claude Sonnet 4 ${glyph('connectorHandoff')} Claude Code CLI · Claude Opus 4`,
  );
});

const suppressedRunnerCallTypes = [
  'runner_call_started',
  'runner_call_text_delta',
  'runner_call_usage',
  'runner_call_tool_use',
  'runner_call_session_id',
  'runner_call_artifact',
  'runner_call_warning',
  'runner_call_error',
  'runner_call_completed',
] as const;

function suppressedRunnerCallEvent(type: (typeof suppressedRunnerCallTypes)[number]): EngineEvent {
  const base = {
    ts: 0,
    phase: 'implementing' as const,
    callId: 'call-1',
    role: 'implementer' as const,
    backendKind: 'cli' as const,
    sequence: 1,
  };

  switch (type) {
    case 'runner_call_started':
      return makeRunnerCallStarted();
    case 'runner_call_text_delta':
      return { type, ...base, channel: 'assistant', text: 'hidden transcript' };
    case 'runner_call_usage':
      return {
        type,
        ...base,
        usage: { inputTokens: 1, outputTokens: 2 },
        semantics: 'delta',
      };
    case 'runner_call_tool_use':
      return {
        type,
        ...base,
        runnerName: 'codex',
        stage: 'delta',
        name: 'Bash',
        inputDelta: '{"command":"npm run typecheck"}',
      };
    case 'runner_call_session_id':
      return { type, ...base, nativeSessionId: 'native-session-1' };
    case 'runner_call_artifact':
      return {
        type,
        ...base,
        artifact: {
          id: 'artifact-1',
          source: 'tool',
          name: 'result.txt',
          path: '/tmp/result.txt',
          mimeType: 'text/plain',
          text: 'artifact body',
        },
      };
    case 'runner_call_warning':
      return {
        type,
        ...base,
        warning: {
          code: 'provider_warning',
          severity: 'warning',
          source: 'provider',
          surface: 'activity',
          fingerprint: 'rw:1',
          message: 'provider warning',
        },
      };
    case 'runner_call_error':
      return makeRunnerCallError();
    case 'runner_call_completed':
      return makeRunnerCallCompleted();
  }
}

function activityLabelSegment(label: Parameters<typeof displayActivityLabel>[0]): string {
  return `${displayActivityLabel(label).padEnd(ACTIVITY_LABEL_PAD)}  `;
}

function activityLine(label: Parameters<typeof displayActivityLabel>[0], value: string): string {
  return `${activityLabelSegment(label)}${value}`;
}

function requireRow(
  rows: ConversationRow[],
  matcher: (row: ConversationRow) => boolean,
): ConversationRow {
  const found = rows.find(matcher);
  if (found === undefined) throw new Error('requireRow: no row matched');
  return found;
}

// Array subscripts are `ConversationRow | undefined` under noUncheckedIndexedAccess, so every row
// lookup in this file goes through one of these two rather than through `rows[i] ?? rows[0]`, which
// type-checks nowhere and hides a missing row behind a neighbour when it does.
function textAt(rows: ConversationRow[], index: number): string {
  const found = rows.at(index);
  if (found === undefined) throw new Error(`textAt: no row at index ${index}`);
  return rowText(found);
}

describe('event row dispatch', () => {
  it.each([true, false])('marks automatic fallback only for a recorded auto=%s switch', (auto) => {
    const rows = eventRows({
      event: {
        type: 'seat_switched',
        ts: 0,
        phase: 'implementing',
        seat: 'build',
        from: { tool: 'codex' },
        to: { tool: 'claude-code' },
        cause: 'runner-usage-limit',
        auto,
        configRevision: 'revision',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 200, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText).join('\n')).toBe(
      `BUILD  OpenAI Codex CLI ${glyph('connectorHandoff')} Claude Code CLI · ${auto ? 'automatic fallback · ' : ''}usage limit`,
    );
  });
  it.each([
    ['build', 'BUILD on T003', 'read when its call ends'],
    ['plan', 'PLAN', 'read at its next call'],
    ['review', 'REVIEW', 'read at its verdict call'],
  ] as const)('renders the recorded steerable queue timing for %s', (seat, target, timing) => {
    for (const steerable of [true, false, undefined]) {
      const text = eventRows({
        event: {
          type: 'message_queued',
          ts: 1,
          phase: 'implementing',
          seat,
          taskId: 'T003',
          id: 'm-1',
          preview: 'Keep the parser changes small.',
          ...(steerable !== undefined && { steerable }),
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 120, viewportRows: 20, streaming },
      })
        .map(rowText)
        .join('\n');
      expect(text).toBe(
        `Queued for ${target} · ${steerable ? 'read after this tool' : timing}\nKeep the parser changes small.`,
      );
    }
  });
  it('says a message queued while the brief runs its checks is read after them', () => {
    const text = eventRows({
      event: {
        type: 'message_queued',
        ts: 1,
        phase: 'validating-task',
        seat: 'build',
        taskId: 'T003',
        id: 'm-1',
        preview: 'Keep the parser changes small.',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');
    expect(text).toBe(
      'Queued for BUILD on T003 · read after its checks\nKeep the parser changes small.',
    );
  });

  it('keeps call capability changes out of the transcript', () => {
    expect(
      eventRowBlock({
        event: {
          type: 'steerable_call',
          ts: 1,
          phase: 'implementing',
          seat: 'build',
          taskId: 'T003',
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 120, viewportRows: 20, streaming },
      }),
    ).toBeNull();
  });

  it.each([
    ['build', 'BUILD on T003'],
    ['plan', 'PLAN'],
    ['review', 'REVIEW'],
  ] as const)('renders a mid-call delivery to %s from its event', (seat, target) => {
    for (const count of [1, 2]) {
      const text = eventRows({
        event: {
          type: 'queue_drained',
          ts: 1,
          phase: 'implementing',
          seat,
          taskId: 'T003',
          count,
          via: 'mid-call',
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 120, viewportRows: 20, streaming },
      })
        .map(rowText)
        .join('\n');
      expect(text).toContain(`Delivered ${count > 1 ? '2 messages ' : ''}mid-call to ${target}`);
    }
  });

  it.each(['plan', 'build', 'review'] as const)(
    'colors a %s seat switch by the recorded seat',
    (seat) => {
      const to = { tool: 'codex', model: 'gpt-5' };
      const rows = eventRows({
        event: {
          type: 'seat_switched',
          ts: 0,
          phase: 'implementing',
          seat,
          from: { tool: 'opencode' },
          to,
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'rev',
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 200, viewportRows: 50, streaming },
      });
      const tone = seat === 'plan' ? 'planner' : seat === 'build' ? 'implementer' : 'reviewer';
      expect(rows[0]?.segments).toEqual([
        { text: CREW_SEAT_LABELS[seat], tone },
        { text: '  ', tone: 'textDim' },
        { text: 'OpenCode CLI', tone },
        { text: ` ${glyph('connectorHandoff')} `, tone: 'textDim' },
        { text: 'OpenAI Codex CLI', tone },
        { text: ' · ', tone: 'textDim' },
        { text: 'GPT-5', tone },
        { text: ' · ', tone: 'textDim' },
        { text: 'automatic fallback', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'usage limit', tone: 'textDim' },
      ]);
    },
  );

  it.each([
    ['user_cancelled', 'Stopped by you', 'warning'],
    [undefined, 'Build failed', 'error'],
  ] as const)('colors workflow halt %s by its outcome', (reason, text, tone) => {
    const rows = eventRows({
      event: {
        type: 'workflow_cancelled',
        ts: 0,
        phase: 'implementing',
        ...(reason === undefined ? {} : { reason }),
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 200, viewportRows: 50, streaming },
    });
    expect(rows.map(rowText)).toEqual([text]);
    if (reason === undefined) {
      expect(rows[0]?.segments).toEqual([
        { text: 'Build', tone: 'implementer', bold: true },
        { text: ' ', tone: 'textDim', bold: true },
        { text: 'failed', tone, bold: true },
      ]);
    } else {
      expect(rows[0]?.segments).toContainEqual({ text, tone, bold: true });
    }
  });

  it.each([
    ['continued', 'success'],
    ['retry-current-task', 'success'],
    ['skipped-current-task', 'warning'],
    ['aborted', 'warning'],
  ] as const)('colors the recovery label for %s', (outcome, tone) => {
    const block = recoveryRowBlock(
      'recovery',
      {
        firstIndex: 0,
        issueId: 'issue',
        resolved: {
          type: 'recovery_resolved',
          ts: 0,
          phase: 'implementing',
          issueId: 'issue',
          reason: 'validation-failed',
          action: 'retry-same-worker',
          outcome,
        },
      },
      200,
    );
    const segments = block?.createRows(0, block.rowCount).flatMap((row) => row.segments);
    expect(segments?.find((span) => span.text.startsWith('Recovery'))?.tone).toBe(tone);
    expect(
      segments
        ?.filter((span) => !span.text.startsWith('Recovery'))
        .every((span) => span.tone === 'textDim'),
    ).toBe(true);
  });

  it.each([
    ['review-failed', 'revise', 'Fix again'],
    ['required-checks-unrunnable', 'retry-same-worker', 'Run the checks again'],
    ['review-input-too-large', 'accept-as-is', 'Skip review with a note'],
  ] as const)('names %s %s as its menu row does', (reason, action, label) => {
    const recorded = { ts: 0, phase: 'final-review', issueId: 'issue', reason, action } as const;
    const block = recoveryRowBlock(
      'recovery',
      {
        firstIndex: 0,
        issueId: 'issue',
        selected: { ...recorded, type: 'recovery_action_selected' },
        resolved: { ...recorded, type: 'recovery_resolved', outcome: 'continued' },
      },
      200,
    );
    expect(
      block
        ?.createRows(0, block.rowCount)
        .map((row) => row.segments.map((span) => span.text).join(''))
        .join('\n'),
    ).toBe(`Recovery  ${label}${arrowSep()}continued`);
  });

  it('colors a reviewer halt during implementing from the prompted seat before any action', () => {
    const prompted = parseEngineEvent({
      type: 'recovery_prompted',
      ts: 0,
      phase: 'implementing',
      issueId: 'issue',
      reason: 'planner-call-failed',
      seat: 'review',
      headline: 'Reviewer call failed',
      headlineSpans: [{ text: 'Reviewer', seat: 'review' }, { text: ' call failed' }],
      availableActions: ['retry-same-worker'],
      recommendedAction: 'retry-same-worker',
      files: [],
      affectedTaskIds: [],
      resumeCommand: 'splitbrief resume',
    });
    if (prompted?.type !== 'recovery_prompted') throw new Error('Expected recovery event');
    const block = recoveryRowBlock('recovery', { firstIndex: 0, issueId: 'issue', prompted }, 120);
    expect(block?.createRows(0, block.rowCount).flatMap((row) => row.segments)).toContainEqual({
      text: 'Reviewer',
      tone: 'reviewer',
    });
  });

  it('uses the recorded recovery headline without reading the current clock', () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Persisted recovery must not read the live clock');
    });
    try {
      const block = recoveryRowBlock(
        'recovery',
        {
          firstIndex: 0,
          issueId: 'issue',
          prompted: {
            type: 'recovery_prompted',
            ts: 1_000,
            phase: 'implementing',
            issueId: 'issue',
            reason: 'planner-call-failed',
            seat: 'review',
            headline: 'Reviewer call failed on the saved attempt',
            headlineSpans: [
              { text: 'Reviewer', seat: 'review' },
              { text: ' call failed on the saved attempt' },
            ],
            availableActions: ['retry-same-worker'],
            recommendedAction: 'retry-same-worker',
            files: [],
            affectedTaskIds: [],
            resumeCommand: 'splitbrief resume',
          },
        },
        120,
      );
      expect(block?.createRows(0, block.rowCount).flatMap((row) => row.segments)).toEqual([
        { text: 'Recovery  ', tone: 'warning' },
        { text: 'Reviewer', tone: 'reviewer' },
        { text: ' call failed on the saved attempt', tone: 'textDim' },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it('parses and renders a saved prompt without a seat using no seat tone', () => {
    const prompted = parseEngineEvent({
      type: 'recovery_prompted',
      ts: 0,
      phase: 'final-review',
      issueId: 'issue',
      reason: 'planner-call-failed',
      headline: 'Reviewer call failed',
      availableActions: ['switch-seat'],
      recommendedAction: 'switch-seat',
      files: [],
      affectedTaskIds: [],
      resumeCommand: 'splitbrief resume',
    });
    if (prompted?.type !== 'recovery_prompted') throw new Error('Expected recovery event');
    const block = recoveryRowBlock('recovery', { firstIndex: 0, issueId: 'issue', prompted }, 120);
    expect(block?.createRows(0, block.rowCount)[0]?.segments).toEqual([
      { text: 'Recovery  ', tone: 'warning' },
      { text: 'Reviewer call failed', tone: 'textDim' },
    ]);
  });

  it('renders recorded seat spans without rebuilding the cause from a partial issue', () => {
    const prompted = parseEngineEvent({
      type: 'recovery_prompted',
      ts: 1_000,
      phase: 'implementing',
      issueId: 'issue',
      reason: 'required-checks-unrunnable',
      seat: 'review',
      headline: 'Review cannot run required checks V1, V2',
      headlineSpans: [
        { text: 'Review', seat: 'review' },
        { text: ' cannot run required checks V1, V2' },
      ],
      availableActions: ['retry-same-worker'],
      recommendedAction: 'retry-same-worker',
      files: [],
      affectedTaskIds: [],
      resumeCommand: 'splitbrief resume',
    });
    if (prompted?.type !== 'recovery_prompted') throw new Error('Expected recovery event');
    const block = recoveryRowBlock('recovery', { firstIndex: 0, issueId: 'issue', prompted }, 120);
    expect(block?.createRows(0, block.rowCount).flatMap((row) => row.segments)).toEqual([
      { text: 'Recovery  ', tone: 'warning' },
      { text: 'Review', tone: 'reviewer' },
      { text: ' cannot run required checks V1, V2', tone: 'textDim' },
    ]);
  });

  it.each(['The reviewer call failed on the saved attempt', 'Planner call failed'])(
    'keeps a recorded headline intact when its formatted seat prefix differs: %s',
    (headline) => {
      const prompted: EngineEventOf<'recovery_prompted'> = {
        type: 'recovery_prompted',
        ts: 1_000,
        phase: 'implementing',
        issueId: 'issue',
        reason: 'planner-call-failed',
        seat: 'review',
        headline,
        availableActions: ['retry-same-worker'],
        recommendedAction: 'retry-same-worker',
        files: [],
        affectedTaskIds: [],
        resumeCommand: 'splitbrief resume',
      };
      const block = recoveryRowBlock(
        'recovery',
        { firstIndex: 0, issueId: 'issue', prompted },
        120,
      );
      expect(block?.createRows(0, block.rowCount).flatMap((row) => row.segments)).toEqual([
        { text: 'Recovery  ', tone: 'warning' },
        { text: headline, tone: 'textDim' },
      ]);
    },
  );

  it('preserves an indented recovery failure continuation while keeping its error lead', () => {
    const rows = eventRows({
      event: {
        type: 'recovery_action_failed',
        ts: 0,
        phase: 'implementing',
        issueId: 'issue',
        reason: 'validation-failed',
        action: 'retry-same-worker',
        message: 'unavailable\n  try another tool',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText)).toEqual([
      'Recovery  Try again blocked: unavailable',
      '  try another tool',
    ]);
    expect(rows[0]?.segments).toEqual([
      { text: 'Recovery  ', tone: 'error' },
      { text: 'Try again', tone: 'textDim' },
      { text: ' ', tone: 'textDim' },
      { text: 'blocked', tone: 'error' },
      { text: ': ', tone: 'textDim' },
      { text: 'unavailable', tone: 'textDim' },
    ]);
    expect(rows[1]?.segments).toEqual([{ text: '  try another tool', tone: 'textDim' }]);
  });

  it('preserves explicit recovery headline indentation and seat tones in a folded card', () => {
    const block = recoveryRowBlock(
      'recovery',
      {
        firstIndex: 0,
        issueId: 'issue',
        prompted: {
          type: 'recovery_prompted',
          ts: 0,
          phase: 'planning',
          issueId: 'issue',
          reason: 'planner-call-failed',
          seat: 'plan',
          headline: 'Planner unavailable\n  try another tool\n    then continue',
          headlineSpans: [
            { text: 'Planner', seat: 'plan' },
            { text: ' unavailable\n  try another tool\n    then continue' },
          ],
          availableActions: ['retry-same-worker'],
          recommendedAction: 'retry-same-worker',
          files: [],
          affectedTaskIds: [],
          resumeCommand: 'splitbrief resume',
        },
      },
      120,
    );
    const rows = block?.createRows(0, block.rowCount);
    expect(rows?.map(rowText)).toEqual([
      'Recovery  Planner unavailable',
      '  try another tool',
      '    then continue',
    ]);
    expect(rows?.map((row) => row.segments)).toEqual([
      [
        { text: 'Recovery  ', tone: 'warning' },
        { text: 'Planner', tone: 'planner' },
        { text: ' unavailable', tone: 'textDim' },
      ],
      [{ text: '  try another tool', tone: 'textDim' }],
      [{ text: '    then continue', tone: 'textDim' }],
    ]);
  });

  it('colors an unresolved recovery label as warning', () => {
    const block = recoveryRowBlock('recovery', { firstIndex: 0, issueId: 'issue' }, 200);
    expect(block?.createRows(0, block.rowCount)[0]?.segments[0]?.tone).toBe('warning');
  });

  it.each([
    ['planner-call-failed', 'review', 'Reviewer call failed', 'Reviewer', 'reviewer'],
    ['planner-call-failed', 'plan', 'Planner call failed', 'Planner', 'planner'],
    [
      'plan-checks-failed',
      'plan',
      'Plan still fails its checks after one repair',
      'Plan',
      'planner',
    ],
    ['review-input-too-large', 'review', 'Review input too large for Codex', 'Review', 'reviewer'],
  ] as const)('colors the seat in a %s recovery headline', (reason, seat, headline, word, tone) => {
    const block = recoveryRowBlock(
      'recovery',
      {
        firstIndex: 0,
        issueId: 'issue',
        prompted: {
          type: 'recovery_prompted',
          ts: 0,
          phase: 'planning',
          issueId: 'issue',
          reason,
          seat,
          headline,
          headlineSpans: [{ text: word, seat }, { text: headline.slice(word.length) }],
          availableActions: ['switch-seat'],
          files: [],
          affectedTaskIds: [],
          recommendedAction: 'switch-seat',
          resumeCommand: 'splitbrief resume',
        },
        selected: {
          type: 'recovery_action_selected',
          ts: 0,
          phase: 'planning',
          issueId: 'issue',
          reason,
          seat,
          action: 'switch-seat',
        },
      },
      120,
    );
    const spans = block?.createRows(0, block.rowCount).flatMap((row) => row.segments);
    expect(spans).toContainEqual({ text: word, tone });
    expect(spans).toContainEqual({ text: CREW_SEAT_LABELS[seat], tone });
    expect(spans).toContainEqual({ text: ' · ', tone: 'textDim' });
  });

  it('names a resolved Apply retry as Re-run Apply', () => {
    const block = recoveryRowBlock(
      'recovery',
      {
        firstIndex: 0,
        issueId: 'issue',
        prompted: {
          type: 'recovery_prompted',
          ts: 0,
          phase: 'complete',
          issueId: 'issue',
          reason: 'apply-partial',
          headline: 'Apply stopped part way',
          availableActions: ['retry-same-worker', 'restore-backup'],
          files: [],
          affectedTaskIds: [],
          recommendedAction: 'retry-same-worker',
          resumeCommand: 'splitbrief resume',
        },
        selected: {
          type: 'recovery_action_selected',
          ts: 0,
          phase: 'complete',
          issueId: 'issue',
          reason: 'apply-partial',
          action: 'retry-same-worker',
        },
        resolved: {
          type: 'recovery_resolved',
          ts: 0,
          phase: 'complete',
          issueId: 'issue',
          reason: 'apply-partial',
          action: 'retry-same-worker',
          outcome: 'continued',
        },
      },
      120,
    );
    expect(block?.createRows(0, block.rowCount).map(rowText)).toEqual([
      `Recovery  Apply stopped part way · Re-run Apply${arrowSep()}continued`,
    ]);
  });

  it('keeps the arrow and the outcome on one row at 60 columns', () => {
    const recorded = {
      ts: 0,
      phase: 'implementing',
      issueId: 'issue',
      reason: 'dependency-blocked',
      action: 'skip-current-task',
    } as const;
    const block = recoveryRowBlock(
      'recovery',
      {
        firstIndex: 0,
        issueId: 'issue',
        prompted: {
          type: 'recovery_prompted',
          ts: 0,
          phase: 'implementing',
          issueId: 'issue',
          reason: 'dependency-blocked',
          headline: 'Dependency blocked on T902',
          availableActions: ['skip-current-task'],
          files: [],
          affectedTaskIds: [],
          recommendedAction: 'skip-current-task',
          resumeCommand: 'splitbrief resume',
        },
        selected: { ...recorded, type: 'recovery_action_selected' },
        resolved: { ...recorded, type: 'recovery_resolved', outcome: 'skipped-current-task' },
      },
      60,
    );
    expect(block?.createRows(0, block.rowCount).map(rowText)).toEqual([
      'Recovery  Dependency blocked on T902 · Skip task',
      `${arrowSep().trimStart()}skipped`,
    ]);
  });

  it.each([
    [true, 0, 0, 'success'],
    [false, 1, 0, 'error'],
    [true, 0, 1, 'warning'],
    [true, 1, 0, 'error'],
  ] as const)(
    'colors drift passed=%s errors=%i warnings=%i',
    (passed, errorCount, warningCount, tone) => {
      const rows = eventRows({
        event: {
          type: 'drift_report',
          ts: 0,
          phase: 'final-review',
          passed,
          errorCount,
          warningCount,
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 200, viewportRows: 50, streaming },
      });
      expect(
        rows
          .flatMap((row) => row.segments)
          .find(
            (span) =>
              span.text ===
              (passed && errorCount === 0 && warningCount === 0
                ? 'clean'
                : !passed
                  ? 'failed'
                  : errorCount > 0
                    ? `${errorCount} error`
                    : `${warningCount} warning`),
          )?.tone,
      ).toBe(tone);
    },
  );

  it('colors a verified no-change result separately from its explanation', () => {
    const rows = eventRows({
      event: {
        type: 'implementer_generate_done',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        file: 'src/a.ts',
        duration: 1_000,
        noChange: true,
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const summary = requireRow(rows, (row) => rowText(row).includes('verified'));
    expect(rowText(summary)).toBe('verified · no change needed');
    expect(summary.segments).toEqual([
      { text: 'verified', tone: 'success' },
      { text: ' · ', tone: 'textDim' },
      { text: 'no change needed', tone: 'textDim' },
    ]);
  });

  it.each(['plan', 'build', 'review'] as const)(
    'colors the %s seat in a recovery action',
    (seat) => {
      const rows = eventRows({
        event: {
          type: 'recovery_action_failed',
          ts: 0,
          phase: 'implementing',
          issueId: 'issue',
          reason: 'runner-usage-limit',
          action: 'switch-seat',
          seat,
          message: 'unavailable',
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      });
      expect(rows[0]?.segments).toEqual([
        { text: 'Recovery  ', tone: 'error' },
        { text: 'Change ', tone: 'textDim' },
        {
          text: CREW_SEAT_LABELS[seat],
          tone: seat === 'plan' ? 'planner' : seat === 'build' ? 'implementer' : 'reviewer',
        },
        { text: ' tool', tone: 'textDim' },
        { text: ' ', tone: 'textDim' },
        { text: 'blocked', tone: 'error' },
        { text: ': ', tone: 'textDim' },
        { text: 'unavailable', tone: 'textDim' },
      ]);
    },
  );
  it('names the files a brief changed beyond its suggested files on one dim row', () => {
    const rows = eventRows({
      event: {
        type: 'task_touched_not_suggested',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T003'),
        files: ['src/x.ts', 'src/y.ts'],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual(['T003 also changed src/x.ts, src/y.ts']);
    expect(rows[0]?.segments.every((segment) => segment.tone === 'textDim')).toBe(true);
  });

  it('records a reject as a wrapped row that holds its whole result', () => {
    const saved = '.splitbrief/sessions/run-1/reverted/2026-10-16T21-37-07-873Z';
    const event = parseEngineEvent({
      type: 'run_rejected',
      ts: 0,
      restored: ['README.md', 'lib/lerp.mjs', 'test/lerp.test.mjs'],
      removed: ['lib/lerp.mjs', 'test/lerp.test.mjs'],
      conflicted: ['lib/clamp.mjs'],
      missing: 0,
      savedTo: saved,
    });
    if (event === null) throw new Error('run_rejected did not parse');
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const texts = rows.map(rowText);

    expect(texts.map((text) => text.trim()).join(' ')).toMatch(
      /^Rejected {2}Put back 1 replaced file, removed 2 created files\. 1 file left as you changed it:/,
    );
    expect(texts.map((text) => text.trim()).join(' ')).toContain(
      `lib/clamp.mjs. The replaced files are saved in ${saved}. The run stays open, so you can reject it again.`,
    );
    expect(texts.every((text) => getTerminalCellWidth(text) <= 80)).toBe(true);
    expect(texts.some((text) => text.endsWith('…'))).toBe(false);
  });

  describe('drift_report rows', () => {
    const base: EngineEventOf<'drift_report'> = {
      type: 'drift_report',
      ts: 0,
      phase: 'final-review',
      passed: true,
      errorCount: 0,
      warningCount: 0,
    };

    function driftRows(
      event: EngineEventOf<'drift_report'>,
      width = 80,
      expanded = false,
    ): ConversationRow[] {
      return eventRows({
        event,
        globalIndex: 0,
        expanded,
        ctx: { width, viewportRows: 20, streaming },
      });
    }

    it.each([60, 80, 120])('renders clean drift as one quiet message row at width %i', (width) => {
      const rows = driftRows({ ...base, findings: [] }, width);

      expect(rows.map(rowText)).toEqual(['Drift · clean']);
      expect(rows.every((row) => row.kind === 'message')).toBe(true);
      expect(
        rows
          .flatMap((row) => row.segments)
          .every(
            (segment) =>
              segment.tone ===
              (segment.text === 'Drift'
                ? 'text'
                : segment.text === 'clean'
                  ? 'success'
                  : 'textDim'),
          ),
      ).toBe(true);
      expect(rows.flatMap((row) => row.segments).some((segment) => segment.bold)).toBe(false);
    });

    it.each([1, 2])('renders %i warnings with a warning headline and dim detail rows', (count) => {
      const findings: DriftFinding[] = [
        { severity: 'warning', code: 'missing_expected_file', message: 'No changes in src/a.ts.' },
        { severity: 'warning', code: 'missing_evidence', message: 'No evidence for T002.' },
      ];
      const event: EngineEventOf<'drift_report'> = {
        ...base,
        warningCount: count,
        findings: findings.slice(0, count),
      };
      const rows = driftRows(event);

      expect(rows.map(rowText)).toEqual([
        count === 1 ? 'Drift · 1 warning' : 'Drift · 2 warnings',
        '  warning · No changes in src/a.ts.',
        ...(count === 2 ? ['  warning · No evidence for T002.'] : []),
      ]);
      expect(rows[0]?.segments).toEqual([
        { text: 'Drift', tone: 'text' },
        { text: ' · ', tone: 'textDim' },
        { text: `${count} ${count === 1 ? 'warning' : 'warnings'}`, tone: 'warning' },
      ]);
      expect(
        rows
          .slice(1)
          .flatMap((row) => row.segments)
          .every(
            (segment) =>
              segment.tone ===
              (segment.text === 'error'
                ? 'error'
                : segment.text === 'warning'
                  ? 'warning'
                  : 'textDim'),
          ),
      ).toBe(true);
    });

    it('renders failed drift in error tone with errors before warnings', () => {
      const rows = driftRows({
        ...base,
        passed: false,
        errorCount: 1,
        warningCount: 1,
        findings: [
          {
            severity: 'warning',
            code: 'missing_expected_file',
            message: 'No changes in src/a.ts.',
          },
          {
            severity: 'error',
            code: 'failed_task_with_diff',
            message: 'Failed task T002 left changes in src/b.ts.',
          },
        ],
      });

      expect(rows.map(rowText)).toEqual([
        'Drift · failed · 1 error · 1 warning',
        '  error · Failed task T002 left changes in src/b.ts.',
        '  warning · No changes in src/a.ts.',
      ]);
      expect(rows[0]?.segments).toContainEqual({ text: 'failed', tone: 'error' });
      expect(rows[0]?.segments).toContainEqual({ text: 'Drift', tone: 'text' });
      expect(
        rows[0]?.segments
          .filter((segment) => segment.text === ' · ')
          .every(
            (segment) =>
              segment.tone ===
              (segment.text === 'error'
                ? 'error'
                : segment.text === 'warning'
                  ? 'warning'
                  : 'textDim'),
          ),
      ).toBe(true);
      expect(
        rows
          .slice(1)
          .flatMap((row) => row.segments)
          .every(
            (segment) =>
              segment.tone ===
              (segment.text === 'error'
                ? 'error'
                : segment.text === 'warning'
                  ? 'warning'
                  : 'textDim'),
          ),
      ).toBe(true);
    });

    it('keeps recorded counts when findings contain fewer errors', () => {
      const rows = driftRows({
        ...base,
        passed: false,
        errorCount: 4,
        findings: [
          { severity: 'error', code: 'failed_task_with_diff', message: 'First error.' },
          { severity: 'info', code: 'out_of_scope_file', message: 'Hidden information.' },
          { severity: 'error', code: 'orphan_diff', message: 'Second error.' },
        ],
      });

      expect(rows.map(rowText)).toEqual([
        'Drift · failed · 4 errors',
        '  error · First error.',
        '  error · Second error.',
      ]);
    });

    const manyFindings: EngineEventOf<'drift_report'> = {
      ...base,
      passed: false,
      errorCount: 3,
      warningCount: 2,
      findings: [
        { severity: 'warning', code: 'missing_expected_file', message: 'First warning.' },
        { severity: 'error', code: 'failed_task_with_diff', message: 'First error.' },
        { severity: 'info', code: 'out_of_scope_file', message: 'Hidden information.' },
        { severity: 'error', code: 'orphan_diff', message: 'Second error.' },
        { severity: 'warning', code: 'missing_evidence', message: 'Second warning.' },
        { severity: 'error', code: 'failed_task_with_diff', message: 'Third error.' },
      ],
    };

    it('collapses to three findings and counts only hidden errors and warnings', () => {
      const rows = driftRows(manyFindings);

      expect(rows.map(rowText)).toEqual([
        'Drift · failed · 3 errors · 2 warnings',
        '  error · First error.',
        '  error · Second error.',
        '  error · Third error.',
        '  +2 more findings · click',
      ]);
      expect(
        rows
          .slice(1)
          .flatMap((row) => row.segments)
          .every(
            (segment) =>
              segment.tone ===
              (segment.text === 'error'
                ? 'error'
                : segment.text === 'warning'
                  ? 'warning'
                  : 'textDim'),
          ),
      ).toBe(true);
    });

    it('expands to all findings in severity order without information or a notice', () => {
      expect(driftRows(manyFindings, 80, true).map(rowText)).toEqual([
        'Drift · failed · 3 errors · 2 warnings',
        '  error · First error.',
        '  error · Second error.',
        '  error · Third error.',
        '  warning · First warning.',
        '  warning · Second warning.',
      ]);
    });

    it('uses a singular finding notice', () => {
      const rows = driftRows({
        ...manyFindings,
        errorCount: 2,
        findings: manyFindings.findings?.slice(0, 5),
      });

      expect(rows.map(rowText)).toEqual([
        'Drift · failed · 2 errors · 2 warnings',
        '  error · First error.',
        '  error · Second error.',
        '  warning · First warning.',
        '  +1 more finding · click',
      ]);
    });

    it('renders a legacy event with counts only and ignores its score', () => {
      const legacy = { ...base, passed: false, errorCount: 1, warningCount: 2, score: 0.6 };

      expect(driftRows(legacy).map(rowText)).toEqual(['Drift · failed · 1 error · 2 warnings']);
      expect(driftRows(legacy, 80, true).map(rowText)).toEqual([
        'Drift · failed · 1 error · 2 warnings',
      ]);
    });

    it.each([
      [0, 0, 'Drift · failed'],
      [1, 0, 'Drift · failed · 1 error'],
      [0, 1, 'Drift · failed · 1 warning'],
    ])(
      'omits zero counts from failed drift with %i errors and %i warnings',
      (errorCount, warningCount, headline) => {
        const rows = driftRows({ ...base, passed: false, errorCount, warningCount });

        expect(rows.map(rowText)).toEqual([headline]);
        expect(rows[0]?.segments).toContainEqual({ text: 'failed', tone: 'error' });
        expect(rows[0]?.segments).toContainEqual({ text: 'Drift', tone: 'text' });
        expect(
          rows[0]?.segments
            .filter((segment) => segment.text === ' · ')
            .every(
              (segment) =>
                segment.tone ===
                (segment.text === 'error'
                  ? 'error'
                  : segment.text === 'warning'
                    ? 'warning'
                    : 'textDim'),
            ),
        ).toBe(true);
      },
    );

    it('keeps information findings out of a clean row', () => {
      expect(
        driftRows({
          ...base,
          findings: [
            { severity: 'info', code: 'out_of_scope_file', message: 'Hidden information.' },
          ],
        }).map(rowText),
      ).toEqual(['Drift · clean']);
    });

    it.each([60, 80, 120])('hangs a long finding within width %i under its first row', (width) => {
      const message =
        'Failed task T002 left changes in src/b.ts. The changes include 日本語 labels and several additional paths that need review before this run can finish.';
      const rows = driftRows(
        {
          ...base,
          passed: false,
          errorCount: 1,
          findings: [{ severity: 'error', code: 'failed_task_with_diff', message }],
        },
        width,
      );
      const details = rows.slice(1);

      expect(textAt(rows, 0)).toBe('Drift · failed · 1 error');
      expect(details.length).toBeGreaterThan(1);
      expect(
        details
          .map((row, index) =>
            rowText(row)
              .slice(index === 0 ? 2 : 4)
              .trimEnd(),
          )
          .join(' '),
      ).toBe(`error · ${message}`);
      for (const [index, row] of details.entries()) {
        expect(rowText(row).search(/\S/)).toBe(index === 0 ? 2 : 4);
        expect(
          row.segments.every(
            (segment) =>
              segment.tone ===
              (segment.text === 'error'
                ? 'error'
                : segment.text === 'warning'
                  ? 'warning'
                  : 'textDim'),
          ),
        ).toBe(true);
      }
      for (const row of rows) {
        expect(getTerminalCellWidth(rowText(row)) + rowLeadingCells(row.kind)).toBeLessThanOrEqual(
          width,
        );
      }
    });

    it('hangs a missing-file warning under its finding before the disclosure row', () => {
      const rows = driftRows(
        {
          ...base,
          warningCount: 5,
          findings: [
            { severity: 'warning', code: 'missing_evidence', message: 'First warning.' },
            { severity: 'warning', code: 'missing_evidence', message: 'Second warning.' },
            {
              severity: 'warning',
              code: 'missing_expected_file',
              message: 'Task T004 reached done but test/renewals.test.js was not changed.',
            },
            { severity: 'warning', code: 'missing_evidence', message: 'Fourth warning.' },
            { severity: 'warning', code: 'missing_evidence', message: 'Fifth warning.' },
          ],
        },
        45,
      );

      expect(rows.map(rowText)).toEqual([
        'Drift · 5 warnings',
        '  warning · First warning.',
        '  warning · Second warning.',
        '  warning · Task T004 reached done but ',
        '    test/renewals.test.js was not changed.',
        '  +2 more findings · click',
      ]);
    });

    it('hangs a wrapped headline and disclosure under their own first rows', () => {
      const rows = driftRows(manyFindings, 28);

      expect(rows.map(rowText)).toEqual([
        'Drift · failed · 3 errors',
        '  2 warnings',
        '  error · First error.',
        '  error · Second error.',
        '  error · Third error.',
        '  +2 more findings ',
        '    click',
      ]);
      for (const row of rows) {
        expect(getTerminalCellWidth(rowText(row)) + rowLeadingCells(row.kind)).toBeLessThanOrEqual(
          28,
        );
      }
    });
  });

  it('reads a retired approval toggle without a transcript row', () => {
    const rows = eventRows({
      event: { type: 'approval_mode_changed', ts: 0, mode: 'yolo' },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows).toEqual([]);
  });

  it('states the lineage attempt and allowance on a retry after a grant', () => {
    const rows = eventRows({
      event: {
        type: 'task_retry',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        attempt: 1,
        maxRetries: 3,
        error: 'failed',
        lineageAttempt: 7,
        attemptAllowance: 12,
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText).join('\n')).toContain('attempt 7 of 12');
  });

  it.each([
    ['balance', 'Balance spent on OpenCode CLI'],
    ['billing', 'Billing refused by OpenCode CLI'],
    ['quota', 'Quota spent on OpenCode CLI'],
  ] as const)('uses the recorded balance headline in the switch row', (accountCause, headline) => {
    const rows = eventRows({
      event: {
        type: 'seat_switched',
        ts: 0,
        phase: 'implementing',
        seat: 'build',
        from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
        cause: 'runner-usage-limit',
        accountCause,
        headline,
        auto: true,
        configRevision: 'revision',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 200, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(headline);
    expect(text).not.toContain('usage limit');
  });

  it('renders a legacy seat switch without inventing a balance cause', () => {
    const to = { tool: 'claude-code', model: 'claude-sonnet-4' } as const;
    const rows = eventRows({
      event: {
        type: 'seat_switched',
        ts: 0,
        phase: 'implementing',
        seat: 'build',
        from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        to,
        cause: 'runner-usage-limit',
        auto: true,
        configRevision: 'abc123',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      `${CREW_SEAT_LABELS.build}  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek ${glyph('connectorHandoff')} ${formatSeatCandidateIdentity(to)} · automatic fallback`,
      'usage limit',
    ]);
    expect(
      rows[0]?.segments
        .filter((segment) => segment.tone === 'implementer')
        .map((segment) => segment.text),
    ).toEqual([
      CREW_SEAT_LABELS.build,
      'OpenCode CLI',
      'DeepSeek V4.1 Flash',
      'via deepseek',
      'Claude Code CLI',
      'Claude Sonnet 4',
    ]);
    expect(rows.map(rowText).join('\n')).not.toContain('Balance spent');
  });

  it('names a signed-out seat switch in the words the halt uses', () => {
    const rows = eventRows({
      event: {
        type: 'seat_switched',
        ts: 0,
        phase: 'implementing',
        seat: 'plan',
        from: { tool: 'codex' },
        to: { tool: 'claude-code' },
        cause: 'runner-unauthenticated',
        auto: true,
        configRevision: 'abc123',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    const text = rows.map(rowText).join('\n');
    expect(text).toContain(CREW_SEAT_LABELS.plan);
    expect(text).toContain('signed out');
  });

  it('strips OSC-52/CSI control bytes from a user prompt row now that it owns the title', () => {
    const payload = 'ZWNobyBwd25lZA==';
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const malicious = `before${esc}]52;c;${payload}${bel}${esc}[2Jafter`;
    const event: EngineEvent = {
      type: 'user_message',
      ts: 0,
      phase: 'idle',
      text: malicious,
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).not.toContain(payload);
    expect(text).not.toContain(']52');
    expect(text).not.toContain('[2J');
    expect(text).toContain('beforeafter');
  });

  describe('a reply that answers a question round in words', () => {
    const round = [
      {
        id: 'module',
        type: 'choice' as const,
        text: 'Which module should change?',
        options: ['src/auth.ts', 'src/session.ts'],
      },
      { id: 'api', type: 'confirm' as const, text: 'Keep the public API?' },
      { id: 'files', type: 'input' as const, text: 'Which files?' },
    ];
    const lines = (event: EngineEvent, width: number) =>
      eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width, viewportRows: 40, streaming },
      });
    const reply = (text: string, questions: readonly ClarificationQuestion[]) =>
      ({
        type: 'user_message',
        ts: 0,
        phase: 'planning',
        text,
        questions: [...questions],
      }) satisfies EngineEvent;

    it.each([
      [1, ['· Which module should change?']],
      [2, ['· Which module should change?', '· Keep the public API?']],
      [3, ['· Which module should change?', '· Keep the public API?', '· Which files?']],
    ])(
      'lists the %i questions of the round, then the reply once under all of them',
      (size, asked) => {
        for (const width of [120, 80, 60]) {
          const rows = lines(
            reply('Change src/session.ts and keep it.', round.slice(0, size)),
            width,
          );

          expect(rows.map(rowText)).toEqual([
            `Answered · ${size === 1 ? '1 question' : `${size} questions`}`,
            ...asked,
            'You → Change src/session.ts and keep it.',
          ]);
          expect(rows.filter((row) => row.kind === 'prompt')).toHaveLength(1);
        }
      },
    );

    it('keeps every line of a reply that spans lines under the questions', () => {
      const rows = lines(reply('Change src/session.ts.\nKeep it.', round.slice(0, 2)), 80);

      expect(rows.map(rowText)).toEqual([
        'Answered · 2 questions',
        '· Which module should change?',
        '· Keep the public API?',
        'You → Change src/session.ts.',
        'Keep it.',
      ]);
    });

    it('wraps a long reply on the content column without a lone last word', () => {
      const text =
        'Change src/session.ts, keep the public API exactly as it is today, and leave the auth flow alone.';
      const rows = lines(reply(text, round.slice(0, 2)), 60).map(rowText);

      expect(rows.slice(0, 3)).toEqual([
        'Answered · 2 questions',
        '· Which module should change?',
        '· Keep the public API?',
      ]);
      const answer = rows.slice(3);
      expect(answer[0]?.startsWith('You → Change')).toBe(true);
      expect(answer.length).toBeGreaterThan(1);
      expect(answer.slice(1).every((line) => line !== '' && !line.startsWith(' '))).toBe(true);
      expect(answer.at(-1)).toContain(' ');
      expect(answer.join(' ').replaceAll(/\s+/g, ' ')).toBe(`You → ${text}`);
    });

    it('hangs a long question under its text, two cells in', () => {
      const long = {
        id: 'scope',
        type: 'input' as const,
        text: 'Which modules and which of their callers should the refactor of the session cover?',
      };
      const rows = lines(reply('Only src/session.ts.', [long]), 60).map(rowText);

      const question = rows.slice(1, -1);
      expect(rows[0]).toBe('Answered · 1 question');
      expect(question.length).toBeGreaterThan(1);
      expect(question[0]?.startsWith('· Which modules')).toBe(true);
      expect(question.slice(1).every((line) => /^ {2}\S/.test(line))).toBe(true);
      expect(question.join(' ').replace(/^· /, '').replaceAll(/\s+/g, ' ')).toBe(long.text);
      expect(rows.at(-1)).toBe('You → Only src/session.ts.');
    });

    it('names the attached files after the answered round', () => {
      const rows = lines(
        {
          ...reply('Read @/Users/me/notes/brief.md', round.slice(0, 2)),
          attachedInputs: [{ path: '/Users/me/notes/brief.md', kind: 'text' }],
        },
        80,
      ).map((row) => rowText(row).trim());

      expect(rows).toEqual([
        'Answered · 2 questions',
        '· Which module should change?',
        '· Keep the public API?',
        'You → Read @/Users/me/notes/brief.md',
        'Attached files · 1',
        'text · /Users/me/notes/brief.md',
      ]);
    });

    it.each([
      [
        'a panel answer',
        [
          { question: 'Which module should change?', answer: 'src/auth.ts' },
          { question: 'Keep the public API?', answer: 'Yes' },
        ],
      ],
      ['an empty ⏎ that takes the default', [{ question: 'Keep the public API?', answer: 'Yes' }]],
      [
        'a typed reply to a review or consult question',
        [{ question: 'Which store?', answer: 'redis' }],
      ],
    ])('keeps the numbered pairs for %s', (_answer, qa) => {
      const rows = lines(
        { type: 'user_message', ts: 0, phase: 'planning', text: 'answers', qa },
        80,
      ).map(rowText);

      expect(rows).toEqual([
        `Answered · ${qa.length === 1 ? '1 question' : `${qa.length} questions`}`,
        ...qa.flatMap((pair, index) => [`${index + 1}. ${pair.question}`, `You → ${pair.answer}`]),
      ]);
    });

    it('shows a reply with no round as the plain reply it always was', () => {
      const rows = lines(
        { type: 'user_message', ts: 0, phase: 'planning', text: 'Keep the public API.' },
        80,
      );

      expect(rows.map(rowText).join('\n')).toContain('Keep the public API.');
      expect(rows.map(rowText).join('\n')).not.toContain('Answered ·');
    });
  });

  describe('the attached files of a request', () => {
    const request: EngineEventOf<'user_message'> = {
      type: 'user_message',
      ts: 0,
      phase: 'idle',
      text: 'build it',
      attachedInputs: [
        { path: '/Users/alice/notes.md', kind: 'text' },
        { path: '/Volumes/design/mock.png', kind: 'image' },
      ],
    };

    function requestLines(event: EngineEvent, width: number): string[] {
      return eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width, viewportRows: 40, streaming },
      })
        .map(rowText)
        .map((line) => line.trim());
    }

    it.each([120, 80, 60])('names every attached file by its full path at %i columns', (width) => {
      const lines = requestLines(request, width);
      const header = lines.indexOf('Attached files · 2');

      expect(lines.findIndex((line) => line.includes('build it'))).toBeLessThan(header);
      expect(lines.slice(header, header + 3)).toEqual([
        'Attached files · 2',
        'text · /Users/alice/notes.md',
        'image · /Volumes/design/mock.png',
      ]);
    });

    it.each([80, 60])('wraps only the path after its kind at %i columns', (width) => {
      const long =
        '/Users/alice/projects/a-rather-long-folder-name/another-nested-level/brief-for-the-feature.md';
      const lines = requestLines(
        { ...request, attachedInputs: [{ path: long, kind: 'text' }] },
        width,
      );
      const files = lines.slice(lines.indexOf('Attached files · 1') + 1);

      expect(files[0]).toMatch(/^text · \/Users\//);
      expect(files.join('')).toBe(`text · ${long}`);
      expect(files.slice(1).every((line) => !line.includes('·'))).toBe(true);
      expect(lines.join('\n')).not.toContain('…');
    });

    it.each(['text', 'image'] as const)('aligns wrapped %s paths under the path start', (kind) => {
      const path = '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md';
      const lines = eventRows({
        event: { ...request, attachedInputs: [{ path, kind }] },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 58, viewportRows: 40, streaming },
      }).map(rowText);
      const header = lines.findIndex((line) => line.includes('Attached files · 1'));
      const files = lines.slice(header + 1);
      const first = files[0];
      if (first === undefined) throw new Error('Missing attached file row');
      const pathStart = first.indexOf('/Users');
      expect(files.length).toBeGreaterThan(1);
      expect(files.slice(1).every((line) => line.startsWith(' '.repeat(pathStart)))).toBe(true);
      expect(
        files.map((line, index) => (index === 0 ? line.slice(pathStart) : line.trim())).join(''),
      ).toBe(path);
      expect(files.every((line) => getTerminalCellWidth(line) <= 58)).toBe(true);
    });

    it.each([80, 60])('keeps the kind beside a path that almost fits at %i columns', (width) => {
      const path = `/Users/me/${'x'.repeat(width - 18)}`;
      const lines = requestLines({ ...request, attachedInputs: [{ path, kind: 'text' }] }, width);
      const files = lines.slice(lines.indexOf('Attached files · 1') + 1);

      expect(files[0]).toMatch(/^text · \/Users\//);
      expect(files.join('')).toBe(`text · ${path}`);
    });

    it.each([
      {
        width: 60,
        files: ['text · /Users/me/notes/product-planning/archive/', 'receiving-workflow/brief.md'],
      },
      {
        width: 80,
        files: ['text · /Users/me/notes/product-planning/archive/receiving-workflow/', 'brief.md'],
      },
      {
        width: 120,
        files: ['text · /Users/me/notes/product-planning/archive/receiving-workflow/brief.md'],
      },
    ])(
      'breaks the outside-file scenario at directory boundaries at $width columns',
      ({ width, files }) => {
        const path = '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md';
        const lines = requestLines(
          { ...request, attachedInputs: [{ path, kind: 'text' }] },
          width - 2,
        );

        expect(lines.slice(lines.indexOf('Attached files · 1') + 1)).toEqual(files);
      },
    );

    it.each([120, 80, 60])(
      'shows attached files once after answered questions at %i columns',
      (width) => {
        const lines = requestLines(
          {
            ...request,
            phase: 'planning',
            text: '1. Which module?\n@/Users/alice/notes.md',
            qa: [{ question: 'Which module?', answer: '@/Users/alice/notes.md' }],
          },
          width,
        );

        expect(lines).toEqual([
          'Answered · 1 question',
          '1. Which module?',
          'You → @/Users/alice/notes.md',
          'Attached files · 2',
          'text · /Users/alice/notes.md',
          'image · /Volumes/design/mock.png',
        ]);
      },
    );

    it('strips terminal control bytes from an attached path', () => {
      const esc = String.fromCharCode(0x1b);
      const bel = String.fromCharCode(0x07);
      const text = requestLines(
        {
          ...request,
          attachedInputs: [{ path: `/tmp/${esc}]0;pwned${bel}brief.md`, kind: 'text' }],
        },
        80,
      ).join('\n');

      expect(text).toContain('text · /tmp/brief.md');
      expect(text).not.toContain('pwned');
    });

    it('shows a file inside the project relative to it and any other file in full', () => {
      configStore.__testReset({ projectDir: '/repo' });
      try {
        const lines = requestLines(
          {
            ...request,
            attachedInputs: [
              { path: '/repo/docs/brief.md', kind: 'text' },
              { path: '/elsewhere/mock.png', kind: 'image' },
            ],
          },
          80,
        );

        expect(lines).toContain('text · docs/brief.md');
        expect(lines).toContain('image · /elsewhere/mock.png');
      } finally {
        configStore.__testReset();
      }
    });

    it('keeps a path with line breaks on its own entry', () => {
      const lines = requestLines(
        {
          ...request,
          attachedInputs: [{ path: '/tmp/a\nreview: passed\n\tbrief.md', kind: 'text' }],
        },
        80,
      );
      const header = lines.indexOf('Attached files · 1');

      expect(lines.slice(header + 1)).toHaveLength(1);
      expect(lines.some((line) => line.startsWith('review: passed'))).toBe(false);
    });

    it('adds no attached-files rows to a request without attached inputs', () => {
      const { attachedInputs: _omitted, ...plain } = request;

      expect(requestLines(plain, 80).join('\n')).not.toContain('Attached files');
    });
  });

  it.each(['researching', 'specifying', 'escalating'] as const)(
    'does not promise resume for %s cancellation events',
    (phase) => {
      const event: EngineEvent = {
        type: 'workflow_cancelled',
        ts: 0,
        phase,
      };

      const text = eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      })
        .map(rowText)
        .join('\n');

      expect(text).toContain('Build failed');
      expect(text).not.toContain('Resume');
      expect(text).not.toContain('splitbrief continue');
    },
  );

  it('renders task_full_fail as a visible failed terminal row', () => {
    const event: EngineEventOf<'task_full_fail'> = {
      type: 'task_full_fail',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual(['Task failed  T001']);
    expect(rows[0]?.kind).toBe('summary');
    expect(rows[0]?.segments).toContainEqual({ text: 'Task failed  ', tone: 'error' });
    expect(rows[0]?.segments).toContainEqual({ text: 'T001', tone: 'textDim' });
  });

  it('renders a planner command the stage did not take as one dim validation row', () => {
    const rows = eventRows({
      event: {
        type: 'warning',
        ts: 0,
        phase: 'planning',
        message: 'The lint stage does not take npm run lint from the planner.',
        category: 'validation',
        code: 'discovered_validation_refused',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Validation  The lint stage does not take npm run lint from the planner.',
    ]);
    expect(rows.flatMap((row) => row.segments).every((segment) => segment.tone !== 'warning')).toBe(
      true,
    );
    expect(rows[0]?.markerTone).toBeUndefined();
  });

  it('redacts secrets in planner, warning, and user display rows', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const events: EngineEvent[] = [
      {
        type: 'planner_text',
        ts: 0,
        phase: 'planning',
        role: 'planner',
        text: `planner token ${secret} ${jwt}\u001b[31m`,
      },
      {
        type: 'warning',
        ts: 0,
        phase: 'implementing',
        message: 'aws AKIAIOSFODNN7EXAMPLE',
      },
      {
        type: 'user_message',
        ts: 0,
        phase: 'implementing',
        text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      },
    ];

    const text = events
      .flatMap((event, globalIndex) =>
        eventRows({
          event,
          globalIndex,
          expanded: false,
          ctx: { width: 80, viewportRows: 20, streaming },
        }),
      )
      .map(rowText)
      .join('\n');

    expect(text).toContain('***REDACTED***');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('eyJhbGci');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('\u001b');
  });

  it('renders sanitized queued message text when queued and injected events carry it', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const events: EngineEvent[] = [
      {
        type: 'message_queued',
        ts: 0,
        phase: 'implementing',
        id: 'queued-1',
        preview: `ship it ${secret}\u001b[31m`,
      },
      {
        type: 'message_injected_native',
        ts: 1,
        phase: 'implementing',
        id: 'queued-1',
        preview: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      },
    ];

    const text = events
      .flatMap((event, globalIndex) =>
        eventRows({
          event,
          globalIndex,
          expanded: false,
          ctx: { width: 120, viewportRows: 20, streaming },
        }),
      )
      .map(rowText)
      .join('\n');

    expect(text).toContain('Queued for BUILD · read when its call ends');
    expect(text).toContain('ship it sk-***REDACTED***');
    expect(text).toContain('Delivered to PLAN\nAuthorization: Bearer ***REDACTED***');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('\u001b');
  });

  it.each(suppressedRunnerCallTypes)('does not render %s as ordinary conversation rows', (type) => {
    const rows = eventRows({
      event: suppressedRunnerCallEvent(type),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows).toEqual([]);
  });

  it('renders safe runner activity as styled conversation rows', () => {
    const event: EngineEventOf<'runner_call_activity'> = {
      type: 'runner_call_activity',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 2,
      activityId: 'call-1:tool:Bash',
      stage: 'updated',
      kind: 'command',
      label: 'running npm run typecheck',
      target: 'npm run typecheck',
      redacted: false,
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      `${CREW_SEAT_LABELS.build} activity  1 update  [OpenAI Codex CLI · auto]`,
      activityLine('RUN', 'npm run typecheck'),
    ]);
    expect(rows[0]?.kind).toBe('activity');
    expect(rows[1]?.segments).toEqual([
      { text: activityLabelSegment('RUN'), tone: 'accent' },
      { text: 'npm run typecheck', tone: 'textDim' },
    ]);
    expect(rows[1]?.kind).toBe('activity-child-last');
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 80)).toBe(true);
  });

  it('renders shell-wrapper activity without exposing the wrapper as the message label', () => {
    const event: EngineEventOf<'runner_call_activity'> = {
      type: 'runner_call_activity',
      ts: 0,
      phase: 'researching',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 2,
      activityId: 'call-1:system',
      stage: 'updated',
      kind: 'unknown',
      label: '/bin/zsh -lc "sed -n \'1,260p\' CLAUDE.md"',
      redacted: false,
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toBe(
      [
        `${CREW_SEAT_LABELS.plan} activity  1 update  [OpenAI Codex CLI · auto]`,
        activityLine('READ', 'CLAUDE.md :1-260'),
      ].join('\n'),
    );
    expect(text).not.toContain('/bin/zsh -lc');
    expect(text).not.toContain('activity:');
  });

  it('redacts secrets in rendered runner activity rows', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const event: EngineEventOf<'runner_call_activity'> = {
      type: 'runner_call_activity',
      ts: 0,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 2,
      activityId: 'call-1:tool:Bash',
      stage: 'updated',
      kind: 'command',
      label: `running npm test ${secret}`,
      target: `npm test ${secret}`,
      redacted: false,
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('sk-***REDACTED***');
    expect(text).not.toContain(secret);
  });

  it('renders a tight fit on a task-start row as its estimate against the window', () => {
    const event: EngineEventOf<'task_started'> = {
      type: 'task_started',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Route narrow task',
      index: 0,
      total: 1,
      file: 'src/app.ts',
      action: 'modify',
      tool: 'codex',
      implementerProfile: 'cheap-cloud',
      contextFit: 'tight',
      estimatedTokens: 95_000,
      contextLength: 100_000,
      routingReason: 'current code reduced to fit cheap-cloud context',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 52, viewportRows: 20, streaming },
    });
    const lines = rows.map(rowText);
    const text = lines.join('\n');

    const normalized = text.replace(/\s+/g, ' ');
    // MAIN112 F4 wraps task-header metadata label-atomically: a label that moves to a
    // continuation drops the ` · ` it broke on. Assert the facts, not the old wrap point.
    expect(normalized).not.toContain('worker cheap-cloud');
    expect(normalized).toContain('~95,000 of 100K context tokens (tight)');
    expect(lines.every((line) => !line.trimEnd().endsWith('·'))).toBe(true);
    expect(normalized).not.toContain('current code reduced');
    expect(lines.every((line) => line.length <= 52)).toBe(true);
  });

  it('keeps ordinary fit task-start routing rows compact', () => {
    const event: EngineEventOf<'task_started'> = {
      type: 'task_started',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Route ordinary task',
      index: 0,
      total: 1,
      file: 'src/app.ts',
      action: 'modify',
      implementerProfile: 'cheap-cloud',
      contextFit: 'fits',
      estimatedTokens: 3911,
      contextLength: 32_768,
      routingReason: 'selected cheapest capable profile',
    };

    const lines = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 52, viewportRows: 20, streaming },
    }).map(rowText);
    const text = lines.join('\n');

    const normalized = text.replace(/\s+/g, ' ');

    expect(normalized).toContain('src/app.ts (modify)');
    expect(normalized).not.toContain('worker cheap-cloud');
    expect(lines.every((line) => !line.trimEnd().endsWith('·'))).toBe(true);
    expect(normalized).not.toContain('fit');
    expect(normalized).not.toContain('selected cheapest capable profile');
    expect(normalized).not.toContain('3,911');
  });

  it.each([
    {
      name: 'error',
      event: {
        type: 'error',
        ts: 0,
        phase: 'implementing',
        message: 'disk write boundary exceeded',
      },
      stateWord: 'Error',
      body: 'disk write boundary exceeded',
    },
    {
      name: 'recovery_action_failed',
      event: {
        type: 'recovery_action_failed',
        ts: 0,
        phase: 'implementing',
        issueId: 'issue-1',
        reason: 'validation-failed',
        action: 'retry-same-worker',
        message: 'worker unavailable',
      },
      stateWord: 'Recovery',
      body: 'worker unavailable',
    },
    {
      name: 'task_full_fail',
      event: {
        type: 'task_full_fail',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
      },
      stateWord: 'Task failed',
      body: 'T001',
    },
    {
      name: 'implementer_generate_failed',
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        model: 'qwen2.5-coder:7b',
        error: 'Tool implementer (opencode) exited without changing any files',
      },
      stateWord: 'failed',
      body: 'Tool implementer (opencode) exited without changing any files',
    },
  ] satisfies {
    name: string;
    event: EngineEvent;
    stateWord: string;
    body: string;
  }[])(
    'keeps only the state word toned and dims the cause for $name',
    ({ event, stateWord, body }) => {
      const segments = eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      }).flatMap((rowValue) => rowValue.segments);

      const tone = 'error';
      const errorSegments = segments.filter((segment) => segment.tone === tone);
      const dimSegments = segments.filter((segment) => segment.tone === 'textDim');

      expect(errorSegments.some((segment) => segment.text.includes(stateWord))).toBe(true);
      expect(errorSegments.every((segment) => !segment.text.includes(body))).toBe(true);
      expect(dimSegments.some((segment) => segment.text.includes(body))).toBe(true);
    },
  );

  it('renders an implementer failure without inventing an absent cause', () => {
    const rows = eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        model: 'qwen2.5-coder:7b',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([`${CREW_SEAT_LABELS.build} failed`]);
    expect(rows[0]?.segments).toEqual([
      { text: 'BUILD', tone: 'implementer' },
      { text: ' ', tone: 'textDim' },
      { text: 'failed', tone: 'error' },
    ]);
  });

  function implementerFailedRows(error: string, width: number): ConversationRow[] {
    return eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T010'),
        model: 'opencode-go/deepseek-v4.1-flash',
        error,
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width, viewportRows: 20, streaming },
    });
  }

  function renderedCells(rowValue: ConversationRow): number {
    return (
      rowLeadingCells(rowValue.kind) +
      getTerminalCellWidth(rowValue.segments.map((segment) => segment.text).join(''))
    );
  }

  it.each([60, 80, 120])(
    'names the cause of an implementer failure on one row at width %i',
    (width) => {
      const cause =
        'Tool implementer (opencode) exited without changing any files after a completed call that reported done for every file in its brief';
      const rows = implementerFailedRows(
        `${cause}\nHint: check the tool's own log for the edits it reported`,
        width,
      );

      expect(rows).toHaveLength(1);
      const text = rowText(rows[0] as ConversationRow);
      expect(text.startsWith(`${CREW_SEAT_LABELS.build} failed  Tool implementer`)).toBe(true);
      expect(text.endsWith('…')).toBe(true);
      expect(text).not.toContain('Hint');
      expect(renderedCells(rows[0] as ConversationRow)).toBeLessThanOrEqual(width);
    },
  );

  it.each([60, 80, 120])(
    'keeps a wide, control-laden implementer cause on one row at width %i',
    (width) => {
      const rows = implementerFailedRows(`\u001b[31m${'界'.repeat(width)}\u001b[0m`, width);

      expect(rows).toHaveLength(1);
      expect(renderedCells(rows[0] as ConversationRow)).toBeLessThanOrEqual(width);
      expect(rowText(rows[0] as ConversationRow)).not.toContain('\u001b');
    },
  );

  it.each([60, 80, 120])('keeps a cut, redacted assignment on one row at width %i', (width) => {
    const rows = implementerFailedRows(`${'x'.repeat(width - 28)} password=x`, width);

    expect(rows).toHaveLength(1);
    expect(renderedCells(rows[0] as ConversationRow)).toBeLessThanOrEqual(width);
    expect(rowText(rows[0] as ConversationRow)).not.toContain('***REDACTED***');
  });

  it('expands a cut implementer failure to the whole cause, wrapped', () => {
    const cause =
      'Tool implementer (opencode) exited without changing any files after a completed call that reported done for every file in its brief';
    const rows = eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T010'),
        model: 'opencode-go/deepseek-v4.1-flash',
        error: cause,
      },
      globalIndex: 0,
      expanded: true,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(rowText).join('\n').replace(/\s+/g, ' ')).toContain(cause);
    expect(rows.every((row) => renderedCells(row) <= 80)).toBe(true);
    expect(rows.map(rowText).join('\n')).not.toContain('…');
  });

  it('keeps a fitting implementer cause on one row even when expanded', () => {
    const rows = eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T010'),
        model: 'opencode-go/deepseek-v4.1-flash',
        error: 'Edit bundle did not apply',
      },
      globalIndex: 0,
      expanded: true,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      `${CREW_SEAT_LABELS.build} failed  Edit bundle did not apply`,
    ]);
  });

  it('names the first non-blank line of an implementer cause', () => {
    for (const error of ['\nEdit bundle did not apply', '   \nEdit bundle did not apply']) {
      expect(implementerFailedRows(error, 80).map(rowText)).toEqual([
        `${CREW_SEAT_LABELS.build} failed  Edit bundle did not apply`,
      ]);
    }
  });

  it('renders the user prompt with a prompt marker row and message continuations', () => {
    const block = eventRowBlock({
      event: {
        type: 'user_message',
        ts: 1,
        phase: 'idle',
        text: 'add dark mode toggle to the settings screen',
      },
      globalIndex: 0,
      ctx: { width: 24, viewportRows: 20, streaming },
      expanded: false,
    });
    const rows = block?.createRows(0, block.rowCount) ?? [];

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.kind).toBe('prompt');
    for (const row of rows.slice(1)) expect(row.kind).toBe('message');
  });

  it('renders answered structured questions as voice-coded q/a pairs', () => {
    const block = eventRowBlock({
      event: {
        type: 'user_message',
        ts: 1,
        phase: 'clarifying',
        text: '1. What should be refactored? Give a file/module/feature name or area of the codebase.\nI want you to first review the changes and then after review make tasks of fixes for implementer\n\n2. What kind of refactor?\nSimplify/clean up existing code',
        qa: [
          {
            question:
              'What should be refactored? Give a file/module/feature name or area of the codebase.',
            answer:
              'I want you to first review the changes and then after review make tasks of fixes for implementer',
          },
          { question: 'What kind of refactor?', answer: 'Simplify/clean up existing code' },
        ],
      },
      globalIndex: 4,
      ctx: { width: 60, viewportRows: 40, streaming },
      expanded: false,
    });
    const rows = block?.createRows(0, block.rowCount) ?? [];
    const texts = rows.map(rowText);

    expect(texts).toEqual([
      'Answered · 2 questions',
      '1. What should be refactored? Give a file/module/feature ',
      '   name or area of the codebase.',
      'You → I want you to first review the changes and then ',
      'after review make tasks of fixes for implementer',
      '2. What kind of refactor?',
      'You → Simplify/clean up existing code',
    ]);
    expect(rows[0]?.kind).toBe('prompt');
    expect(rows[0]?.segments[0]?.tone).toBe('textDim');
    expect(rows[0]?.segments[0]?.bold).toBe(true);
    expect(rows[0]?.segments[1]?.tone).toBe('planner');
    expect(rows[0]?.segments[1]?.bold).toBe(true);
    expect(rows[1]?.segments[0]?.text).toBe('1.');
    expect(rows[1]?.segments[0]?.tone).toBe('planner');
    expect(rows[1]?.segments[0]?.bold).toBe(true);
    expect(rows[1]?.segments[1]?.tone).toBe('text');
    expect(rows[1]?.segments[2]?.tone).toBe('planner');
    expect(rows[1]?.segments[2]?.bold).not.toBe(true);
    expect(rows[2]?.segments[0]?.tone).toBe('planner');
    expect(rows.slice(1, 3).every((rowValue) => rowValue.segments[0]?.tone === 'planner')).toBe(
      true,
    );
    expect(rows.slice(3, 5).every((rowValue) => rowValue.segments[0]?.tone === 'text')).toBe(true);
    expect(rows.slice(3, 5).every((rowValue) => rowValue.segments[0]?.bold === false)).toBe(true);

    expect(rows.filter((rowValue) => rowValue.kind === 'prompt')).toHaveLength(1);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 60)).toBe(true);
  });

  it('starts a wrapped continuation on the column of the line it continues', () => {
    // At 59 columns the `trim: false` wrapper wedges its break space onto the head of the
    // continuation line, one cell past the line above. The block trims it back so the question's
    // continuation keeps the gutter column and the answer's continuation keeps the content column.
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: 'x',
        qa: [
          {
            question:
              'What should be refactored? Give a file/module/feature name or area of the codebase.',
            answer:
              'I want you to first review the changes and then after review make tasks of fixes for implementer',
          },
          { question: 'What kind of refactor?', answer: 'Simplify/clean up existing code' },
        ],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 59, viewportRows: 40, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Answered · 2 questions',
      '1. What should be refactored? Give a file/module/feature',
      '   name or area of the codebase.',
      'You → I want you to first review the changes and then',
      'after review make tasks of fixes for implementer',
      '2. What kind of refactor?',
      'You → Simplify/clean up existing code',
    ]);
  });

  it('labels a single answered question in the singular', () => {
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: '1. Which module?\nsrc/auth.ts',
        qa: [{ question: 'Which module?', answer: 'src/auth.ts' }],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '1. Which module?',
      'You → src/auth.ts',
    ]);
  });

  it.each([
    {
      width: 60,
      answers: ['You → @/Users/me/notes/product-planning/archive/', 'receiving-workflow/brief.md'],
    },
    {
      width: 80,
      answers: ['You → @/Users/me/notes/product-planning/archive/receiving-workflow/', 'brief.md'],
    },
    {
      width: 120,
      answers: ['You → @/Users/me/notes/product-planning/archive/receiving-workflow/brief.md'],
    },
  ])(
    'keeps You → with the path and breaks at directory boundaries at $width columns',
    ({ width, answers: expected }) => {
      const answer = '@/Users/me/notes/product-planning/archive/receiving-workflow/brief.md';
      const rows = eventRows({
        event: {
          type: 'user_message',
          ts: 0,
          phase: 'planning',
          text: `1. Which brief?\n${answer}`,
          qa: [{ question: 'Which brief?', answer }],
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width, viewportRows: 20, streaming },
      });
      const answers = rows.slice(2).map(rowText);
      const bodyWidth = width - rowLeadingCells('message') - 3;

      expect(answers).toEqual(expected);
      expect(answers.join('')).toBe(`You → ${answer}`);
      expect(answers.slice(1).every((line) => !line.includes('→'))).toBe(true);
      expect(rows.every((row) => getTerminalCellWidth(rowText(row)) <= bodyWidth)).toBe(true);
    },
  );

  it.each([60, 80])('preserves a path after answer prose at %i columns', (width) => {
    for (const path of [
      '/Users/me/notes/product-planning/brief.md',
      '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md',
    ]) {
      const answer = `Please use @${path}`;
      const rows = eventRows({
        event: {
          type: 'user_message',
          ts: 0,
          phase: 'planning',
          text: `1. Which brief?\n${answer}`,
          qa: [{ question: 'Which brief?', answer }],
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width, viewportRows: 20, streaming },
      });

      expect(rows.slice(2).map(rowText).join('')).toBe(`You → ${answer}`);
    }
  });

  it('pulls a stranded wrap word down so no line ends the block as one lone word', () => {
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: '1. What should be refactored? Give a file/module/feature name or area of the codebase.\nReview',
        qa: [
          {
            question:
              'What should be refactored? Give a file/module/feature name or area of the codebase.',
            answer: 'Review',
          },
        ],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '1. What should be refactored? Give a file/module/feature name or area of',
      '   the codebase.',
      'You → Review',
    ]);
  });

  it('aligns every number to the widest label so questions share one column, and starts every answer on the content column', () => {
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: 'x',
        qa: Array.from({ length: 11 }, (_, index) => ({
          question: `Question ${index + 1}?`,
          answer: `Answer ${index + 1}`,
        })),
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 40, streaming },
    });

    // `11.` is the widest label, so every number pads to its width plus one space and every
    // question hangs at that shared column. Each answer carries no mark, so it starts on the
    // content column with no leading indent. The bold numbers alone separate the pairs — no blank
    // rows between them.
    const expected = [
      'Answered · 11 questions',
      ...Array.from({ length: 11 }, (_, index) =>
        index === 0
          ? ['1.  Question 1?', 'You → Answer 1']
          : [`${`${index + 1}.`.padEnd(4)}Question ${index + 1}?`, `You → Answer ${index + 1}`],
      ).flat(),
    ];
    expect(rows.map(rowText)).toEqual(expected);
  });

  it('renders user_message rows without the heavy-angle prompt marker', () => {
    const text = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'implementing',
        text: 'ship the redesign',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('ship the redesign');
    expect(text).not.toContain('❯');
  });

  it('turn_interrupted renders a warning callout row', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'implementing',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map((row) => rowText(row).trimEnd())).toEqual(['Stopped mid-turn']);
    expect(rows.every((rowValue) => rowValue.markerTone === 'warning')).toBe(true);
  });

  it('wraps fix-check rows between whole counts and verdict phrases', () => {
    for (const ownLeft of [0, 2]) {
      const event: EngineEventOf<'full_suite'> = {
        type: 'full_suite',
        ts: 0,
        phase: 'implementing',
        moment: 'brief',
        id: 'V2',
        command: 'npm run test-ci',
        status: 'done',
        passed: ownLeft === 0,
        duration: 180_000,
        own: 2,
        ownLeft,
        others: 3,
      };
      const rows = eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      }).map(rowText);
      const text = rows.join('\n');
      expect(text).toContain('2\u00a0failures');
      expect(rows.some((row) => row.includes('3m\u00a00s'))).toBe(true);
      if (ownLeft === 0) expect(rows.some((row) => row.includes('3\u00a0others'))).toBe(true);
      else expect(rows.some((row) => row.includes('2\u00a0of'))).toBe(true);
    }
    const event: EngineEventOf<'full_suite'> = {
      type: 'full_suite',
      ts: 0,
      phase: 'implementing',
      moment: 'brief',
      id: 'V2',
      command: 'npm run test-ci',
      status: 'done',
      passed: true,
      duration: 180_000,
      own: 2,
      ownLeft: 0,
      deferred: 1,
      deferredTo: ['T025'],
      others: 3,
    };
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    }).map(rowText);
    expect(rows.some((row) => row.includes('1\u00a0left\u00a0to\u00a0T025'))).toBe(true);
  });

  it('turn_interrupted at a gate names the gate and never offers a retry', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'reviewing-plan',
      source: 'user',
      at: 'boundary',
      step: { kind: 'gate', gate: 'plan' },
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('at the plan');
    expect(text).not.toContain('reopen');
    expect(text).not.toContain('Turn stopped');
    expect(text).not.toContain('retry');
  });

  it('turn_interrupted at a brief boundary names the brief it pauses before', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'implementing',
      source: 'user',
      at: 'boundary',
      step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('before T002');
    expect(text).not.toContain('Turn stopped');
    expect(text).not.toContain('retry');
    expect(text).not.toContain('after T002');
  });

  it('turn_interrupted mid-brief names the brief and leaves the keys to the byline', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text.trimEnd()).toBe('Stopped at T002');
  });

  it('task_retry counts attempts the way the build block does', () => {
    const event: EngineEventOf<'task_retry'> = {
      type: 'task_retry',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      attempt: 1,
      maxRetries: 2,
      error: 'tests failed',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText).join('\n')).toContain('attempt 2 of 3');
  });

  it('message_queued renders a Queued header above the message text', () => {
    const event: EngineEventOf<'message_queued'> = {
      type: 'message_queued',
      ts: 0,
      phase: 'implementing',
      id: 'queued-1',
      preview: 'ship it',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const joined = rows.map(rowText).join('\n');
    expect(joined).toContain('Queued for BUILD · read when its call ends');
    expect(joined.match(/queued/gi)).toHaveLength(1);
    expect(rows[0]?.markerTone).toBe('info');
    expect(rows[0]?.segments[0]?.tone).toBe('info');
    expect(rows[0]?.segments[1]?.tone).toBe('textDim');
    expect(rows[1] && rowText(rows[1])).toBe('ship it');
    expect(rows[1]?.segments[0]?.tone).toBe('text');
  });

  it('message_queued from a clarification renders an answered header instead of Queued', () => {
    const event: EngineEventOf<'message_queued'> = {
      type: 'message_queued',
      ts: 0,
      phase: 'specifying',
      id: 'queued-2',
      origin: 'clarification',
      preview: 'clarification: Use JWT? -> Yes, use JWT',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const joined = rows.map(rowText).join('\n');
    expect(joined).toContain('Answered  recorded — applied at the next planner call');
    expect(joined).not.toMatch(/queued/i);
    expect(rows[0]?.markerTone).toBe('success');
    expect(rows[0]?.segments[0]?.tone).toBe('success');
    expect(rows[0]?.segments[1]?.tone).toBe('textDim');
    expect(rows[1] && rowText(rows[1])).toBe('clarification: Use JWT? -> Yes, use JWT');
    expect(rows[1]?.segments[0]?.tone).toBe('text');
  });

  it('uses one Delivered tone for native injection and queue delivery', () => {
    const events: EngineEvent[] = [
      { type: 'message_injected_native', ts: 0, phase: 'planning', id: 'm1' },
      { type: 'queue_drained', ts: 1, phase: 'planning', seat: 'plan', count: 1 },
    ];
    for (const event of events) {
      const rows = eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      });
      expect(rows[0]?.segments[0]).toEqual({ text: 'Delivered ', tone: 'success' });
    }
  });

  it('renders old queue events without an active phase as generic receipts', () => {
    const events: EngineEvent[] = [
      { type: 'message_queued', ts: 0, phase: 'idle', id: 'm1' },
      { type: 'queue_drained', ts: 1, phase: 'complete', count: 1 },
    ];
    const text = events.map((event) =>
      eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      })
        .map(rowText)
        .join('\n'),
    );
    expect(text).toEqual(['Queued', 'Delivered']);
  });

  it.each([
    ['build', 'implementing', 'for BUILD on T003 · read when its call ends', 'to BUILD on T003'],
    ['plan', 'planning', 'for PLAN · read at its next call', 'to PLAN'],
    ['review', 'final-review', 'for REVIEW · read at its verdict call', 'to REVIEW'],
  ] as const)('renders queued and delivered messages for %s', (seat, phase, queued, delivered) => {
    const events: EngineEvent[] = [
      {
        type: 'message_queued',
        ts: 0,
        phase,
        seat,
        taskId: 'T003',
        id: 'm-1',
        preview: 'smaller diffs',
      },
      { type: 'queue_drained', ts: 1, phase, seat, taskId: 'T003', count: 1 },
    ];
    const text = events
      .flatMap((event, globalIndex) =>
        eventRows({
          event,
          globalIndex,
          expanded: false,
          ctx: { width: 120, viewportRows: 20, streaming },
        }),
      )
      .map(rowText)
      .join('\n');
    expect(text).toContain(`Queued ${queued}\nsmaller diffs`);
    expect(text).toContain(`Delivered ${delivered}`);
  });

  it.each([
    ['planning', 'PLAN'],
    ['implementing', 'BUILD'],
    ['final-review', 'REVIEW'],
  ] as const)('renders delivery from an old %s log without seat or taskId', (phase, label) => {
    const event: EngineEvent = { type: 'queue_drained', ts: 0, phase, count: 2 };
    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');
    expect(text).toContain(`Delivered 2 messages to ${label}`);
  });

  it('uses the recorded seat and counts multiple delivered build messages', () => {
    const event: EngineEvent = {
      type: 'queue_drained',
      ts: 0,
      phase: 'final-review',
      seat: 'build',
      taskId: 'T003',
      count: 2,
    };
    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');
    expect(text).toContain('Delivered 2 messages to BUILD on T003');
  });

  it.each([1, 2])('renders %i BUILD images delivered as paths in a dim card', (count) => {
    const rows = eventRows({
      event: {
        type: 'build_images_as_paths',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        count,
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText).join('\n')).toContain(
      `Images ${count} ${count === 1 ? 'image' : 'images'} went to BUILD on T001 as paths · this seat takes no images`,
    );
    expect(rows.flatMap((row) => row.segments).every((segment) => segment.tone === 'textDim')).toBe(
      true,
    );
  });
});

describe('validate failure output', () => {
  const columnar = [
    '  × Formatter would have printed the following content:',
    "    16 16 │       ['lm-studio', 'kimi-k2.7-code', { state: 'supported', source: 'provider' }],",
    "    17    │ - ····['lm-studio',·'text-embedding-3-large',·{·state:·'unsupported'·}],",
    '       17 │ + ····[',
  ].join('\n');

  function failedValidate(error: string): EngineEvent {
    return {
      type: 'validate',
      ts: 0,
      phase: 'validating-task',
      taskId: taskId('T002'),
      status: 'done',
      passed: false,
      stages: { typecheck: true, lint: false, test: false },
      attempted: { typecheck: true, lint: true, test: false },
      commands: { typecheck: 'npx tsc --noEmit', lint: 'npm run lint' },
      error,
    };
  }

  it('renders columnar tool output one row per source line, cut at the width', () => {
    const rows = eventRows({
      event: failedValidate(columnar),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });

    const bodyRows = rows.filter((rowValue) => rowValue.kind === 'callout-body');
    const sourceRows = bodyRows.slice(0, columnar.split('\n').length);
    expect(sourceRows.map(rowText).every((text) => text.length > 0)).toBe(true);
    expect(bodyRows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 76)).toBe(true);

    const gutterColumns = new Set(
      bodyRows.map((rowValue) => rowText(rowValue).indexOf('│')).filter((column) => column >= 0),
    );
    expect(gutterColumns.size).toBe(1);
  });

  // The summary row above dropped the commands so it would stop wrapping mid-stage. The header
  // names the failing stage and the footer names the command, once each: carrying the command in
  // both put one string on screen twice, cut at two different columns.
  it('names the failing stage at the head and the command to rerun at the foot', () => {
    const rows = eventRows({
      event: failedValidate(columnar),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });

    const header = requireRow(rows, (rowValue) => rowValue.kind === 'callout-top');
    expect(rowText(header)).toBe('Error  lint');
    expect(header.segments[0]?.tone).toBe('error');
    // The rail is structure: severity lives on the label and the signed rows, never on a
    // full-height column that reads as one field once sixteen colours flatten it.
    expect(
      rows
        .filter((rowValue) => rowValue.kind.startsWith('callout'))
        .every((rowValue) => rowValue.markerTone === 'border'),
    ).toBe(true);
    expect(textAt(rows, -1)).toBe(`${glyph('treeLast')} run npm run lint`);
    expect(rows.filter((rowValue) => rowText(rowValue).includes('npm run lint'))).toHaveLength(1);
  });

  it('keeps a single-line error on one row', () => {
    const rows = eventRows({
      event: failedValidate('typecheck failed'),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });
    const body = rows.filter((rowValue) => rowValue.kind === 'callout-body');

    expect(body.map(rowText)).toEqual([
      'typecheck failed',
      '',
      `${glyph('treeLast')} run npm run lint`,
    ]);
  });

  it('emits no error block while validation is still running', () => {
    const rows = eventRows({
      event: { ...failedValidate(columnar), status: 'running' } as EngineEvent,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });

    expect(rows.some((rowValue) => rowValue.kind === 'callout-body')).toBe(false);
  });

  const exemptValidate: EngineEvent = {
    type: 'validate',
    ts: 0,
    phase: 'validating-task',
    taskId: taskId('T002'),
    status: 'done',
    passed: true,
    exempt: true,
    stages: { typecheck: true, lint: false, test: false },
    attempted: { typecheck: true, lint: true, test: true },
    skipped: { test: true },
    skippedReason: { test: 'no affected test file found' },
    duration: 1_800,
  };

  it('keeps the stage notes off the one-line summary strip', () => {
    const rows = eventRows({
      event: exemptValidate,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });
    const texts = rows.map(rowText);

    expect(texts[0]).toContain('Validate');
    expect(texts[0]).not.toContain('skipped');
    expect(texts.slice(1)).toContain(
      'lint pre-existing failure, test skipped (no affected test file found)',
    );
  });

  // Appended to the strip, the reason a gate never ran was the first thing a narrow terminal cut.
  it('wraps the stage notes rather than cutting the reason at a narrow width', () => {
    const rows = eventRows({
      event: exemptValidate,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 44, viewportRows: 20, streaming },
    });
    const notes = rows.map(rowText).slice(1).join('').replace(/\s+/g, ' ').trim();

    expect(notes).toBe('lint pre-existing failure, test skipped (no affected test file found)');
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 44)).toBe(true);
  });

  it('names a run the user stopped apart from one that fell over', () => {
    const stopped = eventRows({
      event: { type: 'workflow_cancelled', ts: 0, phase: 'implementing', reason: 'user_cancelled' },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(stopped).toContain('Stopped by you');
    expect(stopped).not.toContain('Build failed');
  });
});

describe('consult answer rows', () => {
  const arrow = glyph('connectorHandoff');

  it.each(['plan', 'review', undefined] as const)(
    'keeps the recorded %s seat tone through wrapping',
    (seat) => {
      const label = CREW_SEAT_LABELS[seat ?? 'plan'];
      for (const width of [32, 120]) {
        const rows = eventRows({
          event: {
            type: 'consult_answered',
            ts: 0,
            phase: 'implementing',
            taskId: taskId('T003'),
            seat,
            reason: 'failed',
            action: 'guidance',
            diagnosis: 'Run the checks again.',
            newTaskIds: null,
          },
          globalIndex: 0,
          expanded: false,
          ctx: { width, viewportRows: 20, streaming },
        });
        const spans = rows.flatMap((row) => row.segments);
        expect(spans).toContainEqual({
          text: label,
          tone: seat === 'review' ? 'reviewer' : 'planner',
        });
        expect(
          spans.filter((span) => span.text !== label).every((span) => span.tone === 'textDim'),
        ).toBe(true);
        expect(rows.every((row) => getTerminalCellWidth(rowText(row)) <= width)).toBe(true);
      }
    },
  );

  function rowsFor(event: EngineEventOf<'consult_answered'>): ConversationRow[] {
    return eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });
  }

  it('splits one row naming the new briefs and the diagnosis, never a panel', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'failed',
      action: 'split-task',
      diagnosis: 'Two independent changes share one brief.',
      newTaskIds: [taskId('T011'), taskId('T012')],
    });

    expect(rows.map(rowText)).toEqual([
      `PLAN ${arrow} T003: split into T011, T012 · Two independent changes share one brief.`,
    ]);
    expect(rows[0]?.kind).toBe('message');
    expect(rows.some((rowValue) => rowValue.kind === 'card-top')).toBe(false);
  });

  it('renders guidance with its diagnosis', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'blocked',
      action: 'guidance',
      diagnosis: 'The export is missing.',
      newTaskIds: null,
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: guidance · The export is missing.`]);
  });

  it('renders a rewritten brief with its new revision', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'failed',
      action: 'rewrite-task',
      diagnosis: 'The brief asked for the wrong module.',
      newTaskIds: null,
      revision: 2,
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: rewrote T003 (rev 2)`]);
  });

  it('renders a verification request with the checks it named', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'stale',
      action: 'verify',
      diagnosis: 'The failure may predate the rewrite.',
      newTaskIds: null,
      checkIds: ['C1', 'C2'],
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: verify C1, C2`]);
  });

  it('renders an ask-user answer as the one row pointing at the user', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'blocked',
      action: 'ask-user',
      diagnosis: 'Only you know which account to use.',
      newTaskIds: null,
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: asks you`]);
  });

  it.each([undefined, 'review'] as const)(
    'renders a decision-confirm as one row counting the confirmed decisions with seat %s',
    (seat) => {
      const rows = rowsFor({
        type: 'consult_answered',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T004'),
        reason: 'deviation',
        action: 'confirm',
        diagnosis: 'Both are changes of how.',
        newTaskIds: null,
        decisionCount: 2,
        ...(seat === undefined ? {} : { seat }),
      });

      expect(rows.map(rowText)).toEqual([
        'PLAN confirmed 2 decisions for T004 · Both are changes of how.',
      ]);
      expect(rows[0]?.segments[0]).toMatchObject({ text: 'PLAN', tone: 'planner' });
      expect(rows.some((rowValue) => rowValue.kind === 'card-top')).toBe(false);
    },
  );

  it.each([
    [0, 2, 'PLAN rejected 2 decisions for T004 · C5 needs the four examples.'],
    [1, 1, 'PLAN confirmed 1 decision, rejected 1 for T004 · C5 needs the four examples.'],
  ])(
    'renders a decision-confirm that confirms %i and rejects %i decisions with its reason',
    (decisionCount, rejectedCount, text) => {
      const rows = rowsFor({
        type: 'consult_answered',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T004'),
        reason: 'deviation',
        action: 'confirm',
        diagnosis: 'C5 needs the four examples.',
        newTaskIds: null,
        decisionCount,
        rejectedCount,
      });

      expect(rows.map(rowText)).toEqual([text]);
    },
  );

  it.each([undefined, 'review'] as const)(
    'renders a decision-confirm that asks the user as one row with seat %s',
    (seat) => {
      const rows = rowsFor({
        type: 'consult_answered',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T004'),
        reason: 'deviation',
        action: 'ask-user',
        diagnosis: 'Dropping the flag changes what is built.',
        newTaskIds: null,
        ...(seat === undefined ? {} : { seat }),
      });

      expect(rows.map(rowText)).toEqual(['PLAN asks you about the decisions T004 reported']);
      expect(rows[0]?.segments[0]).toMatchObject({ text: 'PLAN', tone: 'planner' });
    },
  );

  it('keeps the consult consequence events out of the transcript', () => {
    const events: EngineEvent[] = [
      {
        type: 'task_replaced',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T003'),
        revision: 2,
      },
      {
        type: 'tasks_inserted',
        ts: 0,
        phase: 'implementing',
        parentId: taskId('T003'),
        taskIds: [taskId('T011'), taskId('T012')],
      },
      {
        type: 'checks_run',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T003'),
        results: [{ id: 'C1', status: 'pass' }],
      },
      {
        type: 'seat_wait_started',
        ts: 0,
        phase: 'implementing',
        seat: 'plan',
        resetAt: '2026-05-01T10:00:00.000Z',
      },
      {
        type: 'seat_retry',
        ts: 0,
        phase: 'implementing',
        seat: 'plan',
        attempt: 2,
        delayMs: 500,
      },
      {
        type: 'no_progress_cut',
        ts: 0,
        phase: 'implementing',
        taskId: null,
        seat: 'build',
        silentMs: 600_000,
      },
      { type: 'consult_bound_spent', ts: 0, phase: 'implementing' },
      { type: 'workspace_closed', ts: 0, phase: 'complete' },
    ];

    for (const event of events) {
      expect(
        eventRows({
          event,
          globalIndex: 0,
          expanded: false,
          ctx: { width: 120, viewportRows: 20, streaming },
        }),
      ).toEqual([]);
    }
  });
});

describe('review_completed rows', () => {
  function completed(
    blockingFindings?: EngineEventOf<'review_completed'>['blockingFindings'],
  ): EngineEventOf<'review_completed'> {
    return {
      type: 'review_completed',
      ts: 0,
      phase: 'implementing',
      scope: 'task',
      afterTaskId: 'T001',
      tool: 'codex',
      verdict: blockingFindings === undefined ? 'pass' : 'fail',
      findings: { blocking: blockingFindings?.length ?? 0, minor: 0 },
      ...(blockingFindings !== undefined && { blockingFindings }),
      duration: 30_600,
    };
  }

  it('names each finding that failed a review, and stays rowless for a review without one', () => {
    const rows = eventRows({
      event: completed([
        { id: 'F1', text: 'The test file does not contain the four examples of criterion 5.' },
        { id: 'V2', text: 'npm test failed: 2 tests.' },
      ]),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText)).toEqual([
      expect.stringMatching(
        /^Blocking F1 +The test file does not contain the four examples of criterion 5\.$/,
      ),
      expect.stringMatching(/^Blocking V2 +npm test failed: 2 tests\.$/),
    ]);
    expect(
      eventRows({
        event: completed(),
        globalIndex: 0,
        expanded: false,
        ctx: { width: 120, viewportRows: 20, streaming },
      }),
    ).toEqual([]);
  });
});

describe('review_checks rows', () => {
  function reviewChecks(): EngineEventOf<'review_checks'> {
    return {
      type: 'review_checks',
      ts: 0,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [{ id: 'V1', command: 'npm test', reason: 'The unit tests cover the change.' }],
      declined: [
        {
          target: 'npm run test:e2e',
          reason: 'It needs a browser, and the change touches no screen at all.',
        },
      ],
      reason: null,
    };
  }

  it('heads the declined tests, each indented under the headline and wrapped inside the width', () => {
    const rows = eventRows({
      event: reviewChecks(),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 60, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText)).toEqual([
      'Reviewer checks · chose 1 · declined 1',
      '  declined · npm run test:e2e · It needs a browser, and ',
      '    the change touches no screen at all.',
    ]);
    for (const row of rows) {
      expect(getTerminalCellWidth(rowText(row)) + rowLeadingCells(row.kind)).toBeLessThanOrEqual(
        60,
      );
    }
  });

  it('hangs a wrapped header and declined reason under their own first rows', () => {
    const event: EngineEventOf<'review_checks'> = {
      ...reviewChecks(),
      declined: [{ target: 'npm run test:e2e', reason: 'Needs a browser.' }],
    };
    const width = 35;
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width, viewportRows: 20, streaming },
    });
    const texts = rows.map(rowText);

    expect(texts).toEqual([
      'Reviewer checks · chose 1 ',
      '  declined 1',
      '  declined · npm run test:e2e ',
      '    Needs a browser.',
    ]);
    for (const text of texts) {
      expect(text.trimStart().startsWith('·')).toBe(false);
      expect(text.trimEnd().endsWith(' ·')).toBe(false);
      expect(getTerminalCellWidth(text)).toBeLessThanOrEqual(width - rowLeadingCells('message'));
    }
  });

  it('paints one off row when End-of-run checks are off', () => {
    const rows = eventRows({
      event: { type: 'review_checks', ts: 0, phase: 'final-review', scope: 'final', status: 'off' },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const texts = rows.map(rowText).filter((text) => text.trim() !== '');

    expect(texts.map((text) => text.trim())).toEqual([
      'End-of-run checks · off · no reviewer check ran',
    ]);
  });

  it('paints skipped checks as warning with a reviewer seat and dim metadata', () => {
    const rows = eventRows({
      event: {
        ...reviewChecks(),
        status: 'skipped',
        declined: [],
        reason: 'Skip all was chosen on the card',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText)).toEqual([
      'Reviewer checks · not\u00a0run V1 · Skip all was chosen on the card',
    ]);
    expect(rows[0]?.segments).toEqual([
      { text: 'Reviewer', tone: 'reviewer' },
      { text: ' checks', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'not\u00a0run', tone: 'warning' },
      { text: ' V1', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Skip all was chosen on the card', tone: 'textDim' },
    ]);
  });
});
