import { SOFT_SEP } from '../../../../core/separators.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { sanitizeTerminalDisplayText } from '../../../../utils/display-text/sanitize.js';
import { truncateTerminalDisplayText } from '../../../../utils/display-text/truncate.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { shellCommandFromText } from '../../../../utils/shell-quote.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type { ActivityDisplayValueFit } from '../activity-text.js';
import { prettifyShellActivity } from '../shell-activity-pretty.js';
import { stripActivityVerb, runnerActivityLedgerLabel } from './label.js';
import { resolveRunnerActivityModelNames } from './role.js';
import { runnerActivitySeverity, severityTone, valueTone } from './severity.js';
import type {
  RunnerActivityDisplayInput,
  RunnerActivityDisplayOptions,
  RunnerActivityLedgerItem,
  RunnerActivityLedgerLabel,
} from './types.js';

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
  const withoutVerb = display.target ?? stripActivityVerb(display.label);
  const shellCommand =
    shellCommandFromText(withoutVerb) !== null || shellCommandFromText(source) !== null;
  const rawLabel = runnerActivityLedgerLabel(display, { interrupted, shellCommand });
  const rawValue = runnerActivityLedgerValue(display, { interrupted });
  const ordinaryRun = rawLabel === 'RUN' && !interrupted && !isDiagnosticActivity(display);
  const pretty =
    rawLabel === 'RUN' && display.moreLines === undefined ? prettifyShellActivity(rawValue) : null;
  const description = ordinaryRun && pretty === null ? display.description : undefined;
  const scriptLines =
    ordinaryRun && pretty === null && description === undefined ? display.moreLines : undefined;
  const label = pretty?.label ?? rawLabel;
  const value =
    pretty?.value ??
    description ??
    (scriptLines === undefined
      ? rawValue
      : `${rawValue}${SOFT_SEP}+${countNoun(scriptLines, 'line')}`);
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
  const withoutVerb = input.target ?? stripActivityVerb(input.label);
  return shellCommandFromText(withoutVerb) ?? shellCommandFromText(source) ?? withoutVerb;
}

// A path keeps its tail, where the filename is. Prose under the same label keeps its head: cut from
// the left, `Reading the typecheck failure` read `…ing the typecheck failure`.
function activityFitMode(
  label: RunnerActivityLedgerLabel,
  input: RunnerActivityDisplayInput,
  value: string,
): ActivityDisplayValueFit {
  if (label === 'RUN') {
    const described = value === input.description && !isDiagnosticActivity(input);
    return described ? 'end' : 'middle';
  }
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
