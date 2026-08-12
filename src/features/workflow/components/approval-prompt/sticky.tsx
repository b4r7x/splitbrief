import { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { borderStyleFor } from '../../../../lib/glyphs.js';
import { NO_CURSOR, cursorGlyph } from '../../../../components/pickers/cursor-glyph.js';
import { closeApprovalPrompt } from '../../../../stores/approval-prompt/prompt.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { registerMouseZone } from '../../../../lib/terminal/mouse-zones.js';
import { readConversationScrollSnapshot } from '../../layout/snapshot.js';
import {
  GATE_TITLE,
  STICKY_HINTS,
  STICKY_OPTIONS,
  STICKY_PERSIST_NOTE,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  approvalSubjectText,
  getApprovalSeverityWord,
  getStickyOptionZones,
} from '../../prompt-rows/approval.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { SOFT_SEP } from '../../../../components/separators.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';

export const PROMPT_ZONE_Z = 50;

const STICKY_KEY_WIDTH = approvalKeyColumnWidth(STICKY_OPTIONS);

function triggerStickyOption(key: string): void {
  if (key === 'a') {
    closeApprovalPrompt({ decision: 'allow', scope: 'once' });
    return;
  }
  if (key === 's') {
    closeApprovalPrompt({ decision: 'allow', scope: 'session' });
    return;
  }
  if (key === 'w') {
    closeApprovalPrompt({ decision: 'allow', scope: 'always' });
    return;
  }
  closeApprovalPrompt();
}

interface StickyApprovalPromptProps {
  request: TieredApprovalRequest;
  promptRows: number;
  clampedBoxRows?: number | undefined;
  isActive: boolean;
  graceUntil: number;
}

export function StickyApprovalPrompt({
  request,
  promptRows,
  clampedBoxRows,
  isActive,
  graceUntil,
}: StickyApprovalPromptProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);

  useInput(
    (input, key) => {
      if (Date.now() < graceUntil) return;
      if (input === 'a' || input === 'A') {
        closeApprovalPrompt({ decision: 'allow', scope: 'once' });
        return;
      }
      if (input === 's' || input === 'S') {
        closeApprovalPrompt({ decision: 'allow', scope: 'session' });
        return;
      }
      if (input === 'w' || input === 'W') {
        closeApprovalPrompt({ decision: 'allow', scope: 'always' });
        return;
      }
      if (input === 'x' || input === 'X' || key.escape) {
        closeApprovalPrompt();
        return;
      }
    },
    { isActive },
  );

  useEffect(() => {
    if (!isActive) return;
    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;
    const zones = getStickyOptionZones({
      boxTop,
      cols,
      promptRows: clampedBoxRows ?? promptRows,
      actionDescription: request.actionDescription,
    });
    const cleanups = zones.map((zone) =>
      registerMouseZone({
        id: `approval-option-${zone.key}`,
        left: zone.left,
        right: zone.right,
        top: zone.top,
        bottom: zone.bottom,
        z: PROMPT_ZONE_Z,
        onClick: () => triggerStickyOption(zone.key),
      }),
    );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [isActive, cols, rows, promptRows, clampedBoxRows, request]);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyleFor('bold')}
      borderColor={t.border}
      paddingX={1}
      height={promptRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      <Text color={t.textDim}>
        {GATE_TITLE}
        {SOFT_SEP}
        <Text color={t.warning}>{getApprovalSeverityWord(request.actionClass)}</Text>
      </Text>
      <Text> </Text>
      <Text>{approvalSubjectText(request.actionDescription, cols)}</Text>
      <Text> </Text>
      {STICKY_OPTIONS.map((option, index) => (
        <Text key={option.key}>
          {index === 0 ? <Text color={t.text}>{cursorGlyph()}</Text> : NO_CURSOR}
          <Text color={t.textDim}>{approvalOptionKeyCell(option, STICKY_KEY_WIDTH)}</Text>
          {'   '}
          {approvalOptionLabelText(option, STICKY_KEY_WIDTH, approvalTextWidth(cols))}
        </Text>
      ))}
      <Text> </Text>
      <Text color={t.textDim}>{STICKY_PERSIST_NOTE}</Text>
      <Text color={t.textDim}>{STICKY_HINTS}</Text>
    </Box>
  );
}
