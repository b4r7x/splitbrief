import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { TextSpans } from '../../../components/text-spans.js';
import { useState } from 'react';
import { Box, useInput } from 'ink';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { listRowLead } from '../../../components/list-row.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { pluralize } from '../../../utils/pluralize.js';
import { oneLineDisplayText, segmentsForRowText } from '../../../utils/display-text.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { closeReviewChecksPrompt } from '../../../stores/review-checks-prompt/prompt.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';
import type { ReviewChecksApprovalRequest } from '../../../core/approval/types.js';
import {
  REVIEW_CHECKS_CARD_LEGEND,
  REVIEW_CHECKS_ROWS,
  reviewChecksCardLayout,
  reviewChecksCardTitle,
  reviewChecksIdWidth,
  reviewChecksReasonLine,
  reviewChecksVisibleCommands,
  type ReviewChecksRow,
} from './options.js';

export interface ReviewChecksCardProps {
  request: ReviewChecksApprovalRequest;
  focused: boolean;
  height?: number | undefined;
  onFocusChange: (cardFocused: boolean) => void;
}

/**
 * The commands the reviewer chose, shown once per review before any of them runs. Only ⏎ answers:
 * a bare letter selects nothing, so a word typed for the composer never runs or skips the checks.
 */
export function ReviewChecksCard({
  request,
  focused,
  height,
  onFocusChange,
}: ReviewChecksCardProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((state) => state.cols);
  const layout = reviewChecksCardLayout(request, cols);
  const innerWidth = Math.max(1, layout.width - 4);
  const idWidth = reviewChecksIdWidth(request);
  const visible = reviewChecksVisibleCommands(request, cols, height ?? layout.height);
  const titleParts = reviewChecksCardTitle(request);
  const title = fitKeyLegend(titleParts.map((part) => part.text).join(''), innerWidth);
  // A ⏎ already on its way to the composer when the card opens answers nothing.
  const [graceUntil] = useState(() => Date.now() + PROMPT_TYPEAHEAD_GRACE_MS);

  const { selectedIndex } = useStaticSelector<ReviewChecksRow>({
    items: REVIEW_CHECKS_ROWS,
    isActive: focused,
    keyOf: (row) => row.id,
    shouldHandleInput: () => Date.now() >= graceUntil,
    onSelect: (row) => closeReviewChecksPrompt(row.id),
  });

  useInput(
    (_input, key) => {
      if (key.tab) onFocusChange(false);
    },
    { isActive: focused },
  );

  return (
    <Box
      width={layout.width}
      height={height ?? layout.height}
      borderStyle={borderStyleFor('single')}
      borderColor={focused ? t.accent : t.border}
      borderDimColor={!focused}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
    >
      <Box flexShrink={0}>
        <Text color={t.textDim} wrap="truncate-end">
          <TextSpans parts={segmentsForRowText(titleParts, title)} />
        </Text>
      </Box>
      {visible.shown.map((command) => (
        <Box key={command.id} flexShrink={0}>
          <Text wrap="truncate-end">
            {listRowLead('default')}
            <Text color={t.textDim}>{command.id.padEnd(idWidth)}</Text>
            {'  '}
            <Text color={t.textDim}>{oneLineDisplayText(command.command)}</Text>
            <Text color={t.textDim}>{`${SOFT_SEP}${reviewChecksReasonLine(command.reason)}`}</Text>
          </Text>
        </Box>
      ))}
      {visible.hidden > 0 && (
        <Box flexShrink={0}>
          <Text color={t.textDim}>
            {listRowLead('default')}
            {`+${visible.hidden} more ${pluralize(visible.hidden, 'command')}`}
          </Text>
        </Box>
      )}
      {visible.rule && (
        <Box flexShrink={0}>
          <Text color={t.border}>{'─'.repeat(innerWidth)}</Text>
        </Box>
      )}
      <Box height={layout.bodyRows} flexDirection="column" flexShrink={0}>
        {layout.options.map(({ row, parts }, index) => (
          <Box key={row.id} flexDirection="column">
            {parts.map((line, lineIndex) => (
              <Text key={lineIndex} color={index === selectedIndex ? t.accent : t.textDim}>
                {listRowLead(index === selectedIndex && lineIndex === 0 ? 'active' : 'default')}
                <TextSpans parts={line} selected={index === selectedIndex} />
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box flexShrink={0}>
        <Text color={t.textDim}>{fitKeyLegend(REVIEW_CHECKS_CARD_LEGEND, innerWidth)}</Text>
      </Box>
    </Box>
  );
}
