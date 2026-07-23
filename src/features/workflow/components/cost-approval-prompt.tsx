import { useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { formatCostGateSummary } from '../../../core/cost-gate-summary.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import { useTheme } from '../../../components/theme.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { cursorGlyph } from '../../../components/pickers/cursor-glyph.js';
import {
  costApprovalStore,
  closeCostApprovalPrompt,
} from '../../../stores/cost-approval/prompt.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { registerMouseZone } from '../../../lib/terminal/mouse-zones.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import { getApprovalPromptRows } from '../prompt-rows/approval.js';
import {
  COST_HINTS,
  costGateComparisonRows,
  costGateHeaderLine,
  getCostApprovalButtonRowOffset,
  getCostApprovalPromptRowsForPrediction,
} from '../prompt-rows/cost.js';
import { PROMPT_ZONE_Z } from './approval-prompt.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../prompt-grace.js';

export interface CostPromptButtonZone {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CostPromptButtonZones {
  approve: CostPromptButtonZone;
  reject: CostPromptButtonZone;
}

export function getCostApprovalButtonZones(input: {
  boxTop: number;
  cols: number;
  promptRows: number;
  prediction: CostPrediction;
}): CostPromptButtonZones | null {
  const top = input.boxTop + getCostApprovalButtonRowOffset(input.prediction, input.cols);
  const boxBottom = input.boxTop + input.promptRows - 1;
  if (top > boxBottom) return null;
  const left = 1;
  const right = Math.max(1, input.cols);
  const mid = Math.max(left, Math.floor((left + right) / 2));
  return {
    approve: { left, right: mid, top, bottom: top },
    reject: { left: mid + 1, right, top, bottom: top },
  };
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
    if (!zones) return;
    const cleanups = [
      registerMouseZone({
        id: 'cost-approve',
        ...zones.approve,
        z: PROMPT_ZONE_Z,
        onClick: onApprove,
      }),
      registerMouseZone({
        id: 'cost-reject',
        ...zones.reject,
        z: PROMPT_ZONE_Z,
        onClick: onReject,
      }),
    ];
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
      if (input === 'n' || input === 'N' || key.escape) {
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
        borderColor={t.warning}
        height={promptRows}
        width="100%"
        overflow="hidden"
        flexShrink={0}
      >
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
      borderColor={t.warning}
      height={promptRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
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
      {summary.scopeNote ? (
        <>
          <Text color={t.textDim}>{summary.scopeNote}</Text>
          <Text> </Text>
        </>
      ) : null}
      <Text> </Text>
      <CostGateButtons />
      <Text> </Text>
      <Text color={t.textDim}>{COST_HINTS}</Text>
    </Box>
  );
}

function CostGateButtons() {
  const t = useTheme();
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text color={t.accent}>{cursorGlyph()}</Text>
        {'approve?   '}y
      </Text>
      <Text color={t.textDim}>{'n   reject'}</Text>
    </Box>
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
