import { ThemeText as Text, useTheme } from '../../components/theme.js';
import type { ReactNode } from 'react';
import { useInput } from 'ink';
import { OverlayPanel, overlayInnerRowCapacity } from '../../components/overlays/overlay-panel.js';
import { RuleHeader } from '../../components/rule-header.js';
import {
  ScrollableDocument,
  type ScrollableDocumentRow,
} from '../../components/scrollable-document.js';
import { getScrollViewportContentWidth } from '../../components/scrollbar.js';
import { SOFT_SEP } from '../../core/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { overlayRect, type OverlayDensity } from '../../core/navigation/overlay-rect.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-stores.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  splitTerminalGraphemes,
} from '../../utils/display-text.js';
import type { StartPreparationState } from './use-start-preparation.js';

const DENSITY: OverlayDensity = 'compact';
// Title, the blank under it, the hint and the blank above it — the border and the padding are the
// panel's own frame.
const CHROME_ROWS = 4;
const INDENT = '  ';
/** `blocker`, the longest severity word a problem carries, so the detail IDs line up. */
const SEVERITY_WIDTH = 7;
/** Nothing in the report says what to do: the two keys the panel offers are the action. */
const RETRY_ACTION = 'Retry the check, or open settings to change the crew.';

export type StartPreparationPanelProps = Readonly<{
  state: StartPreparationState;
  onRetry: () => void;
  onBack: () => void;
  onOpenSettings: () => void;
  approvalPrompt?: ReactNode | undefined;
}>;

type LineTone = 'cause' | 'text' | 'dim';

type PanelLine =
  | Readonly<{ kind: 'text'; key: string; text: string; tone: LineTone }>
  | Readonly<{ kind: 'rule'; key: string; label: string }>;

function checksOf(report: ReadinessReport | undefined, severity: ReadinessCheck['severity']) {
  if (!report) return [];
  return report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === severity);
}

function hardSplit(word: string, budget: number): string[] {
  const parts: string[] = [];
  let line = '';
  let width = 0;
  for (const grapheme of splitTerminalGraphemes(word)) {
    const cells = getTerminalCellWidth(grapheme);
    if (width > 0 && width + cells > budget) {
      parts.push(line);
      line = '';
      width = 0;
    }
    line += grapheme;
    width += cells;
  }
  if (line !== '') parts.push(line);
  return parts;
}

/**
 * Prose is wrapped here rather than by Ink so every row the scroller counts is exactly one line:
 * a diagnostic that wraps to four rows must cost four, or the fix under it scrolls out of reach.
 */
function wrapText(text: string, budget: number): string[] {
  const width = Math.max(1, budget);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (getTerminalCellWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line !== '') lines.push(line);
    const parts = hardSplit(word, width);
    for (const part of parts.slice(0, -1)) lines.push(part);
    line = parts[parts.length - 1] ?? '';
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/**
 * A marked line hangs: the arrow marks the statement once and every row it wraps to lines up under
 * its text, so three wrapped rows read as one instruction instead of three.
 */
function paragraph(input: {
  key: string;
  text: string;
  tone: LineTone;
  budget: number;
  indent?: string;
  marker?: string;
}): PanelLine[] {
  const indent = input.indent ?? '';
  const marker = input.marker === undefined ? '' : `${input.marker} `;
  const hang = `${indent}${' '.repeat(getTerminalCellWidth(marker))}`;
  return wrapText(input.text, input.budget - getTerminalCellWidth(hang)).map((text, index) => ({
    kind: 'text' as const,
    key: `${input.key}:${index}`,
    text: index === 0 ? `${indent}${marker}${text}` : `${hang}${text}`,
    tone: input.tone,
  }));
}

function blank(key: string): PanelLine {
  return { kind: 'text', key, text: '', tone: 'dim' };
}

function checkLines(check: ReadinessCheck, index: number, budget: number): PanelLine[] {
  const lines = paragraph({
    key: `${check.id}:${index}:summary`,
    text: sanitizeTerminalDisplayText(check.summary),
    tone: 'text',
    budget,
  });
  if (check.fix === undefined) return lines;
  return [
    ...lines,
    ...paragraph({
      key: `${check.id}:${index}:fix`,
      text: sanitizeTerminalDisplayText(check.fix),
      tone: 'dim',
      budget,
      indent: INDENT,
      marker: glyph('connectorHandoff'),
    }),
  ];
}

/** Every entry gets its own air: two checks with no row between them read as one paragraph. */
function spaced(key: string, groups: readonly PanelLine[][]): PanelLine[] {
  return groups.flatMap((group, index) =>
    index === 0 ? group : [blank(`${key}:gap:${index}`), ...group],
  );
}

/**
 * The technical identity of a check and the prose that qualifies it — the check ID, the probe
 * output, the trust-boundary paragraphs — belong under their own rule, below the cause and the
 * action. Nothing is dropped: the panel scrolls, so every line stays reachable. The severity rides
 * with the ID so a check carrying no prose is still a whole entry rather than a bare name.
 */
function detailLines(checks: readonly ReadinessCheck[], budget: number): PanelLine[] {
  return spaced(
    'details',
    checks.map((check, index) => [
      ...paragraph({
        key: `${check.id}:${index}:id`,
        text: sanitizeTerminalDisplayText(check.id),
        tone: 'text',
        budget,
        marker: check.severity.padEnd(SEVERITY_WIDTH),
      }),
      ...(check.details ?? []).flatMap((detail, detailIndex) =>
        paragraph({
          key: `${check.id}:${index}:detail:${detailIndex}`,
          text: sanitizeTerminalDisplayText(detail),
          tone: 'dim',
          budget,
          indent: INDENT,
        }),
      ),
    ]),
  );
}

function section(label: string, lines: PanelLine[]): PanelLine[] {
  if (lines.length === 0) return [];
  return [blank(`${label}:gap`), { kind: 'rule', key: `${label}:rule`, label }, ...lines];
}

interface PanelModel {
  failed: boolean;
  cause: string;
  action: string;
  blockers: readonly ReadinessCheck[];
  warnings: readonly ReadinessCheck[];
  details: readonly ReadinessCheck[];
}

/**
 * The cause leads, and it is never a count: a failure with no blocker at all still has to say what
 * went wrong. A blocked check leads with the first blocker it found and that blocker's own fix; a
 * failed one leads with the error it raised.
 */
function panelModel(
  state: Extract<StartPreparationState, { kind: 'blocked' | 'failed' }>,
): PanelModel {
  const blockers = checksOf(state.report, 'blocker');
  const warnings = checksOf(state.report, 'warning');
  const details = [...blockers, ...warnings];
  if (state.kind === 'failed') {
    const message = sanitizeTerminalDisplayText(state.error.message).trim();
    return {
      failed: true,
      cause: message === '' ? 'Tool preparation failed.' : message,
      action: RETRY_ACTION,
      blockers,
      warnings,
      details,
    };
  }
  const [lead, ...rest] = blockers;
  return {
    failed: false,
    cause:
      lead === undefined
        ? sanitizeTerminalDisplayText(state.report.nextAction.reason)
        : sanitizeTerminalDisplayText(lead.summary),
    action: lead?.fix === undefined ? RETRY_ACTION : sanitizeTerminalDisplayText(lead.fix),
    blockers: rest,
    warnings,
    details,
  };
}

function panelLines(model: PanelModel, budget: number): PanelLine[] {
  return [
    ...paragraph({ key: 'cause', text: model.cause, tone: 'cause', budget }),
    ...paragraph({
      key: 'action',
      text: model.action,
      tone: 'text',
      budget,
      marker: glyph('connectorHandoff'),
    }),
    ...section(
      'Blockers',
      spaced(
        'blockers',
        model.blockers.map((check, index) => checkLines(check, index, budget)),
      ),
    ),
    ...section(
      'Warnings',
      spaced(
        'warnings',
        model.warnings.map((check, index) => checkLines(check, index, budget)),
      ),
    ),
    ...section('Details', detailLines(model.details, budget)),
  ];
}

/** The keys shed from the tail, so the repair actions survive the narrowest panel. */
function fitHint(segments: readonly string[], budget: number): string {
  const kept = [...segments];
  while (kept.length > 1 && getTerminalCellWidth(kept.join(SOFT_SEP)) > budget) kept.pop();
  return kept.join(SOFT_SEP);
}

export function StartPreparationPanel({
  state,
  onRetry,
  onBack,
  onOpenSettings,
  approvalPrompt,
}: StartPreparationPanelProps) {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
  const hasApprovalPrompt = approvalPrompt !== undefined && approvalPrompt !== null;
  const actionable = state.kind === 'blocked' || state.kind === 'failed';
  const isActive = actionable && !hasOverlay && !hasApprovalPrompt;

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (input === 'r' || input === 'R') {
        onRetry();
        return;
      }
      if (input === 's' || input === 'S') onOpenSettings();
    },
    { isActive },
  );

  if (hasApprovalPrompt) return approvalPrompt;
  // A routine check takes no page anywhere: every screen keeps its own chrome and states the
  // check on the fixed status row beside its composer. This panel is for what needs answering.
  if (state.kind === 'idle' || state.kind === 'preparing') return null;

  const rect = overlayRect({ cols, rows, density: DENSITY });
  const capacity = Math.max(1, overlayInnerRowCapacity({ rows, outerChromeRows: CHROME_ROWS }));
  const model = panelModel(state);
  // Measured at the full width first: the scrollbar's column is paid for only once the copy is
  // known not to fit, and taking it back would re-wrap every line under the cause.
  const full = panelLines(model, rect.innerWidth);
  const overflows = full.length > capacity;
  const contentWidth = overflows
    ? getScrollViewportContentWidth(rect.innerWidth, 'padding')
    : rect.innerWidth;
  const lines = overflows ? panelLines(model, contentWidth) : full;
  const documentRows: ScrollableDocumentRow[] = lines.map((line) => ({
    key: line.key,
    node:
      line.kind === 'rule' ? (
        <RuleHeader label={line.label} width={contentWidth} />
      ) : (
        <Text color={toneColor(t, line.tone, model.failed)} wrap="truncate-end">
          {line.text === '' ? ' ' : line.text}
        </Text>
      ),
  }));

  return (
    <OverlayPanel
      title={`Tool preparation${SOFT_SEP}${model.failed ? 'Failed' : 'Blocked'}`}
      density={DENSITY}
      hint={fitHint(
        ['r retry', 'esc back', 's settings', ...(overflows ? ['↑↓ scroll'] : [])],
        rect.innerWidth,
      )}
    >
      <ScrollableDocument
        rows={documentRows}
        height={Math.min(capacity, lines.length)}
        isActive={isActive}
        lineKeys="plain"
        width={rect.innerWidth}
        showScrollIndicators={false}
        showScrollbar
        barColumn="padding"
      />
    </OverlayPanel>
  );
}

function toneColor(
  t: ReturnType<typeof useTheme>,
  tone: LineTone,
  failed: boolean,
): string | undefined {
  if (tone === 'cause') return failed ? t.error : t.warning;
  return tone === 'dim' ? t.textDim : t.text;
}
