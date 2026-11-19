import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { OverlayPanel, type OverlayCard } from '../../components/overlays/panel.js';
import { RuleHeader } from '../../components/rule-header.js';
import { ScrollableDocument } from '../../components/scrollable-document/document.js';
import type { ScrollableDocumentRow } from '../../components/scrollable-document/window.js';
import { getScrollViewportContentWidth } from '../../components/scrollbar.js';
import { SOFT_SEP } from '../../core/separators.js';
import {
  OVERLAY_FRAME_ROWS,
  overlayRect,
  type OverlayDensity,
} from '../../core/navigation/overlay-rect.js';
import { overlayStore, selectHasOverlay } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-many.js';
import type { StartPreparationState } from './use-controller.js';
import { fitHint, panelLines, panelModel, type LineTone } from './panel-lines.js';

const DENSITY: OverlayDensity = 'roomy';
// Title, the blank under it, the hint and the blank above it — the border and the padding are the
// panel's own frame.
const CHROME_ROWS = 4;
const QUESTION_TITLE = `Tool preparation${SOFT_SEP}Needs you`;
export type StartPreparationPanelProps = Readonly<{
  state: StartPreparationState;
  onRetry: () => void;
  onBack: () => void;
  onOpenSettings: () => void;
  /**
   * A question to answer before the tools are ready. It paints this card itself, with the title and
   * density given, so it can budget the card's rows; a terminal too short for every line of the
   * question in the card, or too narrow for every key of its legend, gets its own box instead.
   */
  approvalPrompt?: ((card: OverlayCard) => ReactNode) | undefined;
}>;

export function StartPreparationPanel({
  state,
  onRetry,
  onBack,
  onOpenSettings,
  approvalPrompt,
}: StartPreparationPanelProps) {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const hasOverlay = overlayStore.use(selectHasOverlay);
  const actionable = state.kind === 'blocked' || state.kind === 'failed';
  const model = actionable ? panelModel(state) : null;
  const [expandedError, setExpandedError] = useState<Error | null>(null);
  const hasDetails =
    state.kind === 'failed' &&
    (model?.diagnostic !== undefined || (model?.details.length ?? 0) > 0);
  const expanded = state.kind === 'failed' && expandedError === state.error;
  const isActive = actionable && !hasOverlay && approvalPrompt === undefined;

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
      if (model?.settings && input.toLowerCase() === 's') onOpenSettings();
      if (hasDetails && input.toLowerCase() === 'd')
        setExpandedError(expanded ? null : state.error);
    },
    { isActive },
  );

  if (approvalPrompt !== undefined) {
    return approvalPrompt({ title: QUESTION_TITLE, density: DENSITY });
  }
  // A routine check takes no page anywhere: every screen keeps its own chrome and states the
  // check on the fixed status row beside its composer. This panel is for what needs answering.
  if (model === null) return null;

  const density = model.failed && !expanded ? 'compact' : DENSITY;
  const rect = overlayRect({ cols, rows, density });
  // The card is the page while it shows, not an overlay above one, so it keeps no gutter rows.
  const capacity = Math.max(1, rows - OVERLAY_FRAME_ROWS - CHROME_ROWS + (model.failed ? 2 : 0));
  // Measured at the full width first: the scrollbar's column is paid for only once the copy is
  // known not to fit, and taking it back would re-wrap every line under the cause.
  const full = panelLines(model, rect.innerWidth, expanded);
  const overflows = full.length > capacity;
  const contentWidth = overflows
    ? getScrollViewportContentWidth(rect.innerWidth, 'padding')
    : rect.innerWidth;
  const lines = overflows ? panelLines(model, contentWidth, expanded) : full;
  const documentRows: ScrollableDocumentRow[] = lines.map((line) => ({
    key: line.key,
    node:
      line.kind === 'rule' ? (
        <RuleHeader label={line.label} width={contentWidth} />
      ) : (
        <Text
          bold={model.failed && line.tone === 'cause'}
          color={toneColor(t, line.tone, model.failed)}
          wrap="truncate-end"
        >
          {line.text === '' ? ' ' : line.text}
        </Text>
      ),
  }));

  return (
    <OverlayPanel
      title={model.failed ? undefined : `Tool preparation${SOFT_SEP}Blocked`}
      density={density}
      hint={fitHint(
        [
          'r retry',
          'esc back',
          ...(hasDetails ? [expanded ? 'd hide details' : 'd details'] : []),
          ...(model.settings ? ['s settings'] : []),
          ...(overflows ? ['↑↓ scroll'] : []),
        ],
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
