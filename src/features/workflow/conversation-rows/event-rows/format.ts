import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { formatContextLength } from '../../../../core/formatting.js';
import {
  ValidationStageSchema,
  type TaskContextFit,
  type ValidationStage,
} from '../../../../core/schemas/enums.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import type {
  EngineEvent,
  ValidationStages,
  ValidationStageSkips,
} from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { formatDuration } from '../../../../utils/format/time.js';
import { formatRecordedSeatIdentity } from '../../display/recorded-seat-identity.js';
import { formatUsageTokens } from '../../usage/format.js';
import type { ConversationRowSegment, ConversationRowTone } from '../types.js';
import { separatedSegments } from './full-suite.js';

// The value's own facts, one label each. A label can carry the separator inside it — the tool and
// its model are one label — so callers that lay the value out themselves need the parts, not the
// joined string, or a wrap cannot tell one label's ` · ` from another's.
export function formatTaskStartedParts(
  event: Extract<EngineEvent, { type: 'task_started' }>,
): ConversationRowSegment[] {
  const parts: ConversationRowSegment[] = [
    { text: `${event.file} (${event.action})`, tone: 'textDim' },
  ];
  const identity = formatRecordedSeatIdentity({
    runnerName: event.tool,
    model: event.model,
    axes: event.axes,
    backendKind: event.backendKind,
    role: CREW_SEAT_ROLES.build,
  });
  if (identity !== null) parts.push({ text: identity, tone: CREW_SEAT_ROLES.build });
  if (event.contextFit && event.contextFit !== 'fits') {
    parts.push({
      text: formatEventContextFit(event.contextFit, event.estimatedTokens, event.contextLength),
      tone: 'textDim',
    });
  }
  if (event.currentCodeContextMode && event.currentCodeContextMode !== 'none') {
    parts.push({ text: `code ${event.currentCodeContextMode}`, tone: 'textDim' });
  }
  return parts;
}

// One flat string could not show which stage failed without being read word by word, and it wrapped
// mid-stage. Each stage is its own toned segment now, and dropping the command keeps the row on one
// line at every width — the failing stage's command moves to the error block below it.
export function validationSummarySegments(
  event: Extract<EngineEvent, { type: 'validate' }>,
): ConversationRowSegment[] {
  if (event.status === 'stopped')
    return [
      { text: 'Validate', tone: 'textDim' },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: 'stopped', tone: stateTone('attention') },
    ];
  const segments: ConversationRowSegment[] = [{ text: 'Validate', tone: 'textDim' }];
  for (const stage of ValidationStageSchema.options) {
    const state = validationStageSymbol(event, event.stages, stage, event.skipped);
    segments.push(
      { text: '  ', tone: 'textDim' },
      { text: stageGlyph(state), tone: stageTone(state) },
      { text: ` ${stage}`, tone: 'textDim' },
    );
  }
  if (event.duration) {
    segments.push(
      { text: '  ', tone: 'textDim' },
      { text: formatDuration(event.duration), tone: 'textDim' },
    );
  }
  return segments;
}

// A glyph is enough to say a gate passed; it is not enough to say one never ran, or that the one
// that failed was already red before the task started. Those two verdicts say themselves in the
// words the evidence ledger uses for them, so the row and the ledger read alike.
export function validationStageNotes(event: Extract<EngineEvent, { type: 'validate' }>): string[] {
  return ValidationStageSchema.options.flatMap((stage) => {
    const state = validationStageSymbol(event, event.stages, stage, event.skipped);
    if (state === 'exempt') return [`${stage} pre-existing failure`];
    if (state !== 'skipped') return [];
    const reason = event.skippedReason?.[stage];
    return [reason === undefined ? `${stage} skipped` : `${stage} skipped (${reason})`];
  });
}

function stageGlyph(state: ValidationStageState): string {
  if (state === 'passed') return glyph('check');
  if (state === 'failed' || state === 'exempt') return glyph('statusFailed');
  if (state === 'running') return glyph('statusInProgress');
  if (state === 'skipped') return glyph('statusSkipped');
  return glyph('statusPending');
}

function stageTone(state: ValidationStageState): ConversationRowTone {
  if (state === 'passed') return stateTone('passed');
  if (state === 'failed') return stateTone('failed');
  // The task did not break this gate, and the run was accepted with it red, so the cross is not
  // this task's failure to answer for.
  if (state === 'exempt') return stateTone('attention');
  if (state === 'running') return stateTone('running');
  return stateTone('pending');
}

export function reviewChecksSegments(
  event: Extract<EngineEvent, { type: 'review_checks' }>,
): ConversationRowSegment[] {
  return [
    { text: 'End-of-run checks', tone: 'textDim' },
    ...separatedSegments(
      event.status === 'off'
        ? [
            { text: 'off', tone: stateTone('attention') },
            { text: 'no reviewer check ran', tone: 'textDim' },
          ]
        : [
            { text: 'none', tone: 'textDim' },
            { text: 'the plan names no project gate', tone: 'textDim' },
          ],
    ),
  ];
}

export function reviewNoneSegments(): ConversationRowSegment[] {
  return [
    { text: 'Review', tone: 'textDim' },
    ...separatedSegments([
      { text: 'none', tone: 'textDim' },
      { text: 'no seat reviewed this run', tone: 'textDim' },
    ]),
  ];
}

function formatEventContextFit(
  contextFit: TaskContextFit,
  estimatedTokens: number | undefined,
  contextLength: number | undefined,
): string {
  if (estimatedTokens === undefined) return `context (${contextFit})`;
  // A brief over its window runs only with Prompt budget `auto`, where the tool handles its own
  // context, so the row shows the estimate alone.
  if (contextFit === 'overflow') return `~${formatUsageTokens(estimatedTokens)} context tokens`;
  const window = formatContextLength(contextLength);
  const share = window === '' ? '' : ` of ${window}`;
  return `~${formatUsageTokens(estimatedTokens)}${share} context tokens (${contextFit})`;
}

type ValidationStageState = 'passed' | 'failed' | 'exempt' | 'running' | 'skipped' | 'not-run';

function validationStageSymbol(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stages: ValidationStages,
  stage: ValidationStage,
  skipped: ValidationStageSkips | undefined,
): ValidationStageState {
  if (skipped?.[stage]) return 'skipped';
  if (event.status === 'running' && event.activeStage === stage) return 'running';
  if (stages[stage]) return 'passed';
  if (event.status === 'done' && validationStageWasAttempted(event, stage, skipped)) {
    // An exempt event is accepted only when every stage it failed was already failing at baseline.
    return event.exempt === true ? 'exempt' : 'failed';
  }
  return 'not-run';
}

function validationStageWasAttempted(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stage: ValidationStage,
  skipped: ValidationStageSkips | undefined,
): boolean {
  if (event.attempted !== undefined) return event.attempted[stage];
  return event.stages[stage] || skipped?.[stage] === true || !event.passed;
}
