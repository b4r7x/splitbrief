import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { resolveModelDisplayName } from '../../../engine/providers/model/display-names.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
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
  activityId?: string | undefined;
  stage: EngineEventOf<'runner_call_activity'>['stage'];
  kind: Exclude<EngineEventOf<'runner_call_activity'>['kind'], 'session'>;
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
  backendKind?: EngineEventOf<'runner_call_activity'>['backendKind'] | undefined;
  /** Raw model ids a fallback or refusal warning named, when its frame carried them. */
  originalModel?: string | undefined;
  fallbackModel?: string | undefined;
}

export interface RunnerActivityDisplayOptions {
  /**
   * The catalog the row resolves raw warning model ids against. Production
   * leaves it unset and reads the live model cache; tests pin their own
   * accessor so a resolution case never depends on a machine's own catalogs.
   */
  cache?: ModelCacheAccessor | undefined;
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
  | 'ART'
  | 'WARN'
  | 'ERR'
  | 'STOP'
  | 'LIST';

const DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS = 80;
const INTERNAL_RUNNER_INTERRUPTED_PATTERN = /\brunner_interrupted\b/g;

export function isProtocolActivity(
  input: Pick<EngineEventOf<'runner_call_activity'>, 'kind' | 'label'>,
): boolean {
  return input.kind === 'unknown' && /^tool StructuredOutput$/i.test(input.label.trim());
}

export function runnerActivityLedgerItem(
  input: RunnerActivityDisplayInput,
  options: RunnerActivityDisplayOptions = {},
): RunnerActivityLedgerItem | null {
  const resolvedValue = resolveRunnerActivityModelNames(input, options.cache);
  const display: RunnerActivityDisplayInput =
    resolvedValue === null ? input : { ...input, diagnosticPartial: resolvedValue };
  const interrupted = isUserInterruptedActivity(display);

  if (!interrupted && !isDiagnosticActivity(display)) {
    const hasDetail =
      (display.target !== undefined && display.target.trim().length > 0) ||
      (display.diagnosticPartial !== undefined && display.diagnosticPartial.trim().length > 0) ||
      (display.textPartial !== undefined && display.textPartial.trim().length > 0);

    if (/^tool (Bash|Shell)$/i.test(display.label.trim()) && !hasDetail) {
      return null;
    }

    if (
      display.kind === 'command' &&
      (display.target === undefined || display.target.trim().length === 0)
    ) {
      const commandInLabel = stripActivityVerb(display.label).trim();
      if (commandInLabel.length === 0 || commandInLabel.toLowerCase() === 'command') {
        return null;
      }
    }
  }
  const source = display.target ?? display.label;
  const withoutVerb = stripActivityVerb(source);
  const shellCommand =
    shellCommandFromText(withoutVerb) !== null || shellCommandFromText(source) !== null;
  const rawLabel = runnerActivityLedgerLabel(display, { interrupted, shellCommand });
  const rawValue = runnerActivityLedgerValue(display, { interrupted });
  const pretty = rawLabel === 'RUN' ? prettifyShellActivity(rawValue) : null;
  const label = pretty?.label ?? rawLabel;
  const value = pretty?.value ?? rawValue;
  const diagnosticPreview = runnerActivityDiagnosticPreview(display);
  const severity = runnerActivitySeverity(display, { interrupted });
  // A stopped call reads in the user's words; the raw tag is not for that row.
  const rawMarker = display.rawAvailable === true && !interrupted ? 'raw' : null;

  return {
    visibleKey: input.activityId ?? [label, value, rawMarker ?? ''].join('\u0000'),
    groupingKey: label.toLowerCase(),
    label,
    groupLabel: label.toLowerCase(),
    value,
    tone: severityTone(severity),
    valueTone: valueTone(display.stage, severity),
    fitMode: activityFitMode(label, display, value),
    severity,
    rawMarker,
    diagnosticPreview,
  };
}

/**
 * Spells the raw model ids a fallback or refusal warning interpolates with the
 * names the origin call's runner catalog uses, keeping a raw id the catalog does
 * not know. Longest id first, so a shorter id never rewrites part of a longer
 * sibling. Returns null when the row named no ids (historical or incomplete
 * records), no message carries them, or nothing resolved.
 */
export function resolveRunnerActivityModelNames(
  input: RunnerActivityDisplayInput,
  cache: ModelCacheAccessor = modelCacheStore,
): string | null {
  const message = input.diagnosticPartial;
  if (message === undefined) return null;
  if (input.role === undefined) return null;
  const providerId = activityModelProviderId(input.runnerName);
  if (providerId === undefined) return null;
  const rawIds = [input.originalModel, input.fallbackModel].filter(
    (model): model is string => model !== undefined && model.length > 0,
  );
  if (rawIds.length === 0) return null;

  let text = message;
  for (const model of [...rawIds].sort((left, right) => right.length - left.length)) {
    const displayName = resolveModelDisplayName({
      providerId,
      model,
      role: runnerActivityModelRole(input.role),
      cache,
      kind: input.backendKind,
    });
    if (displayName === undefined || displayName === model) continue;
    text = text.split(model).join(displayName);
  }
  return text === message ? null : text;
}

function activityModelProviderId(runnerName: string | undefined): string | undefined {
  if (runnerName === undefined) return undefined;
  return cliToolIdForCommand(runnerName) ?? runnerName;
}

/** The seat whose model catalog names the call's model; the planner's runner makes the side calls. */
export function runnerActivityModelRole(
  role: EngineEventOf<'runner_call_activity'>['role'],
): ActiveRunnerRole {
  switch (role) {
    case 'implementer':
      return 'implementer';
    case 'review':
      return 'reviewer';
    case 'planner':
    case 'summary':
    case 'compaction':
    case 'escalation':
      return 'planner';
    default:
      return assertNever(role);
  }
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
      return CREW_SEAT_LABELS.plan;
    case 'implementer':
      return CREW_SEAT_LABELS.build;
    case 'review':
      return CREW_SEAT_LABELS.review;
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

function runnerActivityLedgerValue(
  input: RunnerActivityDisplayInput,
  opts: { interrupted: boolean },
): string {
  const detail = runnerActivityDiagnosticPreview(input);
  if (opts.interrupted) {
    return detail ? `current turn interrupted: ${detail}` : 'current turn interrupted';
  }
  // A warning or a failure reads the tool's own message, never the code SPLITBRIEF tagged it with.
  if (detail !== null) return detail;

  if (/^tool (Read|Write|Edit|MultiEdit)$/i.test(input.label)) return 'file';

  const source = input.target ?? input.label;
  const withoutVerb = stripActivityVerb(source);
  return shellCommandFromText(withoutVerb) ?? shellCommandFromText(source) ?? withoutVerb;
}

function runnerActivityLedgerLabel(
  input: RunnerActivityDisplayInput,
  opts: { interrupted: boolean; shellCommand: boolean },
): RunnerActivityLedgerLabel {
  if (opts.interrupted) return 'STOP';
  if (/^tool Read$/i.test(input.label)) return 'READ';
  if (/^tool (Write|Edit|MultiEdit)$/i.test(input.label)) return 'EDIT';
  if (/^tool (Bash|Shell)$/i.test(input.label)) return 'RUN';

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

// A path keeps its tail, where the filename is. Prose under the same label keeps its head: cut from
// the left, `Reading the typecheck failure` read `…ing the typecheck failure`.
function activityFitMode(
  label: RunnerActivityLedgerLabel,
  input: RunnerActivityDisplayInput,
  value: string,
): ActivityDisplayValueFit {
  if (label === 'RUN') return 'middle';
  if (label === 'READ' || label === 'EDIT' || label === 'LIST' || input.kind === 'file') {
    return isProse(value) ? 'end' : 'start';
  }
  if (label === 'WARN') return 'segments';
  if (label === 'ERR' || label === 'STOP') return 'middle';
  return 'end';
}

// `CLAUDE.md :1-240` and `My Projects/a.ts` are paths; `Reading the typecheck failure` is not.
function isProse(value: string): boolean {
  const words = value.trim().split(/\s+/u);
  return words.length > 1 && !value.includes('/') && !(words[0] ?? '').includes('.');
}

function isUserInterruptedActivity(input: RunnerActivityDisplayInput): boolean {
  return input.stage === 'aborted' && input.kind === 'error';
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
