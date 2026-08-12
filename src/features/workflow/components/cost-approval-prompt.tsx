import { useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { formatCostGateSummary } from '../../../core/cost-gate-summary.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import { useTheme } from '../../../components/theme.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { NO_CURSOR, cursorGlyph } from '../../../components/pickers/cursor-glyph.js';
import {
  costApprovalStore,
  closeCostApprovalPrompt,
} from '../../../stores/cost-approval/prompt.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { registerMouseZone } from '../../../lib/terminal/mouse-zones.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import {
  APPROVAL_OPTION_FIRST_ROW_OFFSET,
  GATE_TITLE,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  getApprovalOptionZones,
  getApprovalPromptRows,
  type PromptOptionZone,
} from '../prompt-rows/approval.js';
import {
  COST_HINTS,
  COST_KIND,
  COST_OPTIONS,
  costGateComparisonRows,
  costGateHeaderLine,
  getCostApprovalButtonRowOffset,
  getCostApprovalPromptRowsForPrediction,
} from '../prompt-rows/cost.js';
import { costTextWidth } from '../prompt-rows/measure.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { PROMPT_ZONE_Z } from './approval-prompt.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';

// Stacked full-width rows, measured by the same helper the approval panels use: the cost gate is
// one more gate, not a dialog with its own button bar, and at 110 columns a split-justified pair
// put the second choice ninety columns from the first.
export function getCostApprovalButtonZones(input: {
  boxTop: number;
  cols: number;
  promptRows: number;
  prediction: CostPrediction;
}): PromptOptionZone[] {
  const optionOffset = getCostApprovalButtonRowOffset(input.prediction, input.cols);
  return getApprovalOptionZones({
    boxTop: input.boxTop,
    cols: input.cols,
    promptRows: input.promptRows,
    subjectRows: optionOffset - APPROVAL_OPTION_FIRST_ROW_OFFSET,
    options: COST_OPTIONS,
  });
}

interface CostApprovalPromptProps {
  prediction: CostPrediction;
  onApprove: () => void;
  onReject: () => void;
  clampedBoxRows?: number;
}

export function CostApprovalPrompt({
  prediction,
  onApprove,
  onReject,
  clampedBoxRows,
}: CostApprovalPromptProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const summary = formatCostGateSummary(prediction);
  const promptRows = getCostApprovalPromptRowsForPrediction(prediction, cols);
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const graceUntilRef = useRef(Date.now() + PROMPT_TYPEAHEAD_GRACE_MS);

  useEffect(() => {
    graceUntilRef.current = Date.now() + PROMPT_TYPEAHEAD_GRACE_MS;
  }, [prediction]);

  useEffect(() => {
    if (hasOverlay) return;
    const { contentRect } = readConversationScrollSnapshot();
    const approvalOffset = getApprovalPromptRows(approvalPromptStore.get(), cols);
    const boxTop = contentRect.top + contentRect.height + approvalOffset;
    const zoneBoxRows =
      clampedBoxRows === undefined ? promptRows : Math.max(0, clampedBoxRows - approvalOffset);
    const zones = getCostApprovalButtonZones({ boxTop, cols, promptRows: zoneBoxRows, prediction });
    const cleanups = zones.map((zone) =>
      registerMouseZone({
        id: zone.key === 'y' ? 'cost-approve' : 'cost-reject',
        left: zone.left,
        right: zone.right,
        top: zone.top,
        bottom: zone.bottom,
        z: PROMPT_ZONE_Z,
        onClick: zone.key === 'y' ? onApprove : onReject,
      }),
    );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [hasOverlay, cols, rows, promptRows, clampedBoxRows, prediction, onApprove, onReject]);

  useInput(
    (input, key) => {
      if (Date.now() < graceUntilRef.current) return;
      if (input === 'y' || input === 'Y' || key.return) {
        onApprove();
        return;
      }
      if (input === 'x' || input === 'X' || input === 'n' || input === 'N' || key.escape) {
        onReject();
        return;
      }
    },
    { isActive: !hasOverlay },
  );

  const border = borderStyleFor('bold');

  if (!summary) {
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        borderStyle={border}
        borderColor={t.border}
        height={promptRows}
        width="100%"
        overflow="hidden"
        flexShrink={0}
      >
        <CostGateTitle />
        <Text> </Text>
        <Text> </Text>
        <CostGateButtons />
        <Text> </Text>
        <Text color={t.textDim}>{COST_HINTS}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle={border}
      borderColor={t.border}
      height={promptRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      <CostGateTitle />
      <Text> </Text>
      <Text color={t.text}>{costGateHeaderLine(summary)}</Text>
      {costGateComparisonRows(summary).map((row) => (
        <Text key={row.label}>
          <Text color={t.textDim}>
            {row.label}
            {'  '}
          </Text>
          <Text color={row.emphasis ? t.success : t.text}>{row.value}</Text>
        </Text>
      ))}
      {summary.scopeNote ? <Text color={t.textDim}>{summary.scopeNote}</Text> : null}
      <Text> </Text>
      <CostGateButtons />
      <Text> </Text>
      <Text color={t.textDim}>{COST_HINTS}</Text>
    </Box>
  );
}

function CostGateTitle() {
  const t = useTheme();
  return (
    <Text color={t.textDim}>
      {GATE_TITLE}
      {SOFT_SEP}
      <Text color={t.warning}>{COST_KIND}</Text>
    </Text>
  );
}

function CostGateButtons() {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const keyWidth = approvalKeyColumnWidth(COST_OPTIONS);
  return (
    <>
      {COST_OPTIONS.map((option, index) => (
        <Text key={option.key}>
          {index === 0 ? <Text color={t.text}>{cursorGlyph()}</Text> : NO_CURSOR}
          <Text color={t.textDim}>{approvalOptionKeyCell(option, keyWidth)}</Text>
          {'   '}
          {approvalOptionLabelText(option, keyWidth, costTextWidth(cols))}
        </Text>
      ))}
    </>
  );
}

export function CostApprovalPromptConnected({ clampedBoxRows }: { clampedBoxRows?: number }) {
  const state = costApprovalStore.use((s) => s);
  if (state.status !== 'pending') return null;
  return (
    <CostApprovalPrompt
      prediction={state.prediction}
      onApprove={() => closeCostApprovalPrompt({ approved: true })}
      onReject={() => closeCostApprovalPrompt({ approved: false })}
      {...(clampedBoxRows === undefined ? {} : { clampedBoxRows })}
    />
  );
}
