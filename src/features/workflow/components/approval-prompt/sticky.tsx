import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { borderStyleFor } from '../../../../lib/glyphs.js';
import { NO_CURSOR, cursorGlyph } from '../../../../components/pickers/cursor-glyph.js';
import { closeApprovalPrompt } from '../../../../stores/approval-prompt/prompt.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { registerMouseZone } from '../../../../lib/terminal/mouse-zones.js';
import { readConversationScrollSnapshot } from '../../layout/snapshot.js';
import {
  STICKY_HINTS,
  STICKY_OPTIONS,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  approvalSubjectText,
  approvalTitle,
  getStickyOptionZones,
  stickyLeadShed,
  stickySpacersShed,
} from '../../prompt-rows/approval.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { clamp } from '../../../../utils/math.js';
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
  const boxRows = Math.min(promptRows, clampedBoxRows ?? promptRows);
  const spacersShed = stickySpacersShed(promptRows, boxRows);
  const [selected, setSelected] = useState(0);

  useInput(
    (input, key) => {
      if (Date.now() < graceUntil) return;
      if (key.escape) {
        closeApprovalPrompt();
        return;
      }
      if (key.upArrow || key.downArrow) {
        setSelected((index) =>
          clamp(index + (key.downArrow ? 1 : -1), 0, STICKY_OPTIONS.length - 1),
        );
        return;
      }
      if (key.return) {
        triggerStickyOption(STICKY_OPTIONS[selected]?.key ?? 'x');
        return;
      }
      const pressed = input.toLowerCase();
      if (STICKY_OPTIONS.some((option) => option.key === pressed)) {
        triggerStickyOption(pressed);
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
      promptRows: boxRows,
      actionDescription: request.actionDescription,
      leadShed: stickyLeadShed(spacersShed),
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
  }, [isActive, cols, rows, promptRows, boxRows, spacersShed, request]);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyleFor('bold')}
      borderColor={t.border}
      paddingX={1}
      height={boxRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      <Text color={t.warning}>{approvalTitle(request.actionClass)}</Text>
      {spacersShed < 1 && <Text> </Text>}
      <Text>{approvalSubjectText(request.actionDescription, cols)}</Text>
      {spacersShed < 2 && <Text> </Text>}
      {STICKY_OPTIONS.map((option, index) => (
        <Text key={option.key}>
          {index === selected ? <Text color={t.text}>{cursorGlyph()}</Text> : NO_CURSOR}
          <Text color={t.textDim}>{approvalOptionKeyCell(option, STICKY_KEY_WIDTH)}</Text>
          {'   '}
          {approvalOptionLabelText({
            option,
            keyWidth: STICKY_KEY_WIDTH,
            width: approvalTextWidth(cols),
          })}
        </Text>
      ))}
      {spacersShed < 3 && <Text> </Text>}
      <Text color={t.textDim}>{STICKY_HINTS}</Text>
    </Box>
  );
}
