import type { EngineEventOf } from '../../../engine/events/types.js';
import {
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../../utils/display-text.js';
import { shellCommandFromText } from '../../../utils/shell-quote.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ActivityDisplayValueFit } from './activity-display-text.js';
import { prettifyShellActivity } from './shell-activity-pretty.js';

export type RunnerActivityLedgerTone = 'info' | 'success' | 'warning' | 'error' | 'textDim';
export type RunnerActivitySeverity = 'info' | 'warning' | 'error';

export interface RunnerActivityDisplayInput {
  stage: EngineEventOf<'runner_call_activity'>['stage'];
  kind: EngineEventOf<'runner_call_activity'>['kind'];
  label: string;
  target?: string | undefined;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
  rawAvailable?: boolean | undefined;
  redacted?: boolean | undefined;
  role?: EngineEventOf<'runner_call_activity'>['role'] | undefined;
  phase?: EngineEventOf<'runner_call_activity'>['phase'] | undefined;
  runnerName?: string | undefined;
  model?: string | undefined;
}

export interface RunnerActivityLedgerItem {
  visibleKey: string;
  groupingKey: string;
  label: RunnerActivityLedgerLabel;
  groupLabel: string;
  value: string;
  tone: RunnerActivityLedgerTone;
  valueTone: RunnerActivityLedgerTone;
  fitMode: ActivityDisplayValueFit;
  severity: RunnerActivitySeverity;
  pinned: boolean;
  rawMarker: string | null;
  diagnosticPreview: string | null;
}

export type RunnerActivityLedgerLabel =
  | 'RUN'
  | 'READ'
  | 'EDIT'
  | 'FIND'
  | 'CALL'
  | 'PLAN'
  | 'SESS'
  | 'ART'
  | 'WARN'
  | 'ERR'
  | 'LIST';

const DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS = 80;
const INTERNAL_RUNNER_INTERRUPTED_PATTERN = /\brunner_interrupted\b/g;

export function runnerActivityLedgerItem(
  input: RunnerActivityDisplayInput,
): RunnerActivityLedgerItem {
  const interrupted = isUserInterruptedActivity(input);
  const source = input.target ?? input.label;
  const withoutVerb = stripActivityVerb(source);
  const shellCommand =
    shellCommandFromText(withoutVerb) !== null || shellCommandFromText(source) !== null;
  const rawLabel = runnerActivityLedgerLabel(input, { interrupted, shellCommand });
  const rawValue = runnerActivityLedgerValue(input, { interrupted });
  const pretty = rawLabel === 'RUN' ? prettifyShellActivity(rawValue) : null;
  const label = pretty?.label ?? rawLabel;
  const value = pretty?.value ?? rawValue;
  const diagnosticPreview = runnerActivityDiagnosticPreview(input);
  const severity = runnerActivitySeverity(input, { interrupted });
  const rawMarker = input.rawAvailable === true ? 'raw' : null;

  return {
    visibleKey: [label, value, rawMarker ?? ''].join('\u0000'),
    groupingKey: label.toLowerCase(),
    label,
    groupLabel: label.toLowerCase(),
    value,
    tone: severityTone(severity),
    valueTone: valueTone(input.stage, severity),
    fitMode: activityFitMode(label, input),
    severity,
    pinned: severity !== 'info',
    rawMarker,
    diagnosticPreview,
  };
}

export function cleanRunnerActivityText(text: string): string {
  return sanitizeTerminalDisplayText(text)
    .replace(INTERNAL_RUNNER_INTERRUPTED_PATTERN, 'interrupted')
    .replace(/\s+/g, ' ')
    .trim();
}

export function runnerActivityDiagnosticPreview(
  input: RunnerActivityDisplayInput,
  maxCells = DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS,
): string | null {
  if (!isDiagnosticActivity(input)) return null;

  const source = input.diagnosticPartial ?? input.textPartial;
  if (source === undefined) return null;

  const clean = cleanRunnerActivityText(source);
  if (clean.length === 0) return null;

  return truncateTerminalDisplayText(clean, maxCells);
}

export function runnerActivityRoleLabel(
  role: EngineEventOf<'runner_call_activity'>['role'],
): string {
  switch (role) {
    case 'planner':
      return 'Plan';
    case 'implementer':
      return 'Implementer';
    case 'review':
      return 'Review';
    case 'summary':
      return 'Summary';
    case 'compaction':
      return 'Compaction';
    case 'escalation':
      return 'Escalation';
    default:
      return assertNever(role);
  }
}

export function runnerActivitySeverityRank(severity: RunnerActivitySeverity): number {
  switch (severity) {
    case 'info':
      return 0;
    case 'warning':
      return 1;
    case 'error':
      return 2;
    default:
      return assertNever(severity);
  }
}

function runnerActivityLedgerValue(
  input: RunnerActivityDisplayInput,
  opts: { interrupted: boolean },
): string {
  if (opts.interrupted) {
    const detail = runnerActivityDiagnosticPreview(input);
    return detail ? `current turn interrupted: ${detail}` : 'current turn interrupted';
  }

  const source = input.target ?? input.label;
  const withoutVerb = stripActivityVerb(source);
  const primary = shellCommandFromText(withoutVerb) ?? shellCommandFromText(source) ?? withoutVerb;
  const detail = runnerActivityDiagnosticPreview(input);
  if (detail === null || primary.includes(detail)) return primary;
  return `${primary}: ${detail}`;
}

function runnerActivityLedgerLabel(
  input: RunnerActivityDisplayInput,
  opts: { interrupted: boolean; shellCommand: boolean },
): RunnerActivityLedgerLabel {
  if (opts.interrupted) return 'WARN';

  switch (input.kind) {
    case 'warning':
      return 'WARN';
    case 'error':
      return 'ERR';
    case 'command':
      return 'RUN';
    case 'read':
    case 'file':
    case 'text':
      return 'READ';
    case 'write':
    case 'edit':
      return 'EDIT';
    case 'search':
    case 'glob':
      return 'FIND';
    case 'web':
    case 'mcp':
    case 'tool':
    case 'unknown':
      return opts.shellCommand ? 'RUN' : 'CALL';
    case 'plan':
    case 'task':
      return 'PLAN';
    case 'session':
      return 'SESS';
    case 'artifact':
      return 'ART';
    default:
      return assertNever(input.kind);
  }
}

function runnerActivitySeverity(
  input: RunnerActivityDisplayInput,
  opts: { interrupted: boolean },
): RunnerActivitySeverity {
  if (opts.interrupted) return 'warning';
  if (input.kind === 'error') return 'error';
  if (input.kind === 'warning') return 'warning';

  switch (input.stage) {
    case 'failed':
    case 'timeout':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return 'error';
    case 'warning':
    case 'aborted':
      return 'warning';
    case 'started':
    case 'updated':
    case 'completed':
      return 'info';
    default:
      return assertNever(input.stage);
  }
}

function severityTone(severity: RunnerActivitySeverity): RunnerActivityLedgerTone {
  switch (severity) {
    case 'info':
      return 'info';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return assertNever(severity);
  }
}

function valueTone(
  stage: RunnerActivityDisplayInput['stage'],
  severity: RunnerActivitySeverity,
): RunnerActivityLedgerTone {
  if (severity !== 'info') return severity;
  switch (stage) {
    case 'completed':
      return 'textDim';
    case 'started':
    case 'updated':
      return 'textDim';
    case 'warning':
    case 'aborted':
      return 'warning';
    case 'failed':
    case 'timeout':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return 'error';
    default:
      return assertNever(stage);
  }
}

function activityFitMode(
  label: RunnerActivityLedgerLabel,
  input: RunnerActivityDisplayInput,
): ActivityDisplayValueFit {
  if (label === 'RUN') return 'middle';
  if (label === 'READ' || label === 'EDIT' || label === 'LIST' || input.kind === 'file') {
    return 'start';
  }
  if (label === 'WARN' || label === 'ERR') return 'middle';
  return 'end';
}

function isUserInterruptedActivity(input: RunnerActivityDisplayInput): boolean {
  return (
    input.stage === 'aborted' &&
    input.kind === 'error' &&
    input.label.includes('runner_interrupted')
  );
}

function isDiagnosticActivity(input: RunnerActivityDisplayInput): boolean {
  if (input.kind === 'warning' || input.kind === 'error') return true;

  switch (input.stage) {
    case 'warning':
    case 'aborted':
    case 'failed':
    case 'timeout':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return true;
    case 'started':
    case 'updated':
    case 'completed':
      return false;
    default:
      return assertNever(input.stage);
  }
}

function stripActivityVerb(text: string): string {
  const prefixes = [
    'aborted ',
    'running ',
    'reading ',
    'editing ',
    'searching ',
    'matching ',
    'calling ',
    'planning ',
    'session ',
    'artifact ',
    'warning ',
    'failed ',
    'timeout ',
    'truncated ',
    'refused ',
    'unsupported_tool ',
    'incomplete ',
  ];
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return text;
}
