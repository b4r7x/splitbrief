import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { getMethodDisplay } from '../../../core/sessions/display.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { formatDuration } from '../../../utils/format-time.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { glyph } from '../../../lib/glyphs.js';

const MARKER_CELLS = 2;
// Two spaces divide the title from the detail run, `·` divides the run's own parts — the same two
// levels a running task header uses, so a settled row and a live row read the same way.
const TITLE_SEP = '  ';

interface FittedDetailRun {
  head: string;
  tail: string[];
}

// A `·`-joined run carries its meaning at the end: the filename, the outcome. Cutting it at the
// right edge takes exactly the part worth reading and leaves `models-de…`, which could be
// models-dev.ts or models-detect.ts. Whole segments come off the tail instead, and the last one
// standing is fitted from the middle so a path keeps both of its ends.
function fitDetailRun(head: string, tail: string[], width: number): FittedDetailRun {
  const budget = Math.max(0, width - MARKER_CELLS);
  const segments = [...tail];
  const cells = (parts: string[]): number =>
    getTerminalCellWidth(parts.length === 0 ? head : `${head}${TITLE_SEP}${parts.join(SOFT_SEP)}`);

  while (segments.length > 1 && cells(segments) > budget) segments.pop();
  if (cells(segments) <= budget) return { head, tail: segments };

  const only = segments[0];
  const room = budget - getTerminalCellWidth(head) - TITLE_SEP.length;
  if (only !== undefined && room > 0) {
    return { head, tail: [truncateTerminalDisplayTextMiddle(only, room)] };
  }
  return { head: truncateTerminalDisplayText(head, budget), tail: [] };
}

interface TaskSummaryProps {
  index: number;
  title: string;
  method: TaskCompletionMethod;
  width: number;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  reason?: string | undefined;
  focused?: boolean | undefined;
}

export function TaskSummary({
  index,
  title,
  method,
  width,
  retries,
  duration,
  file,
  reason,
  focused,
}: TaskSummaryProps) {
  const t = useTheme();
  const safeTitle = sanitizeTerminalDisplayText(title);
  const safeFile = file === undefined ? undefined : sanitizeTerminalDisplayText(file);
  const safeReason = reason === undefined ? undefined : sanitizeTerminalDisplayText(reason);
  // One two-cell marker slot, the same one a queued row uses, so a settled task and a pending task
  // line their markers up in the same column instead of sitting two apart.
  //
  // The bar is `text`, not `accent`: this glyph also marks the live row in the sidebar and the
  // focused row in the transcript, and one glyph wearing three colours across three panes reads as
  // three different affordances.
  const focusBar = (
    <Text color={t.text} bold>
      {`${glyph('liveBar')} `}
    </Text>
  );
  const leadingSlot = focused === true ? focusBar : <Text color={t.textDim}>{'  '}</Text>;
  const doneSlot =
    focused === true ? focusBar : <Text color={t.success}>{`${glyph('check')} `}</Text>;

  if (method === 'failed') {
    return (
      <Box>
        <Text wrap="truncate-end">
          {leadingSlot}
          <Text color={t.textDim}>
            T{index} {safeTitle}
          </Text>
          <Text color={t.error} dimColor>
            {' failed'}
          </Text>
        </Text>
      </Box>
    );
  }

  if (method === 'skipped') {
    const skipped = fitDetailRun(
      `T${index} ${safeTitle}`,
      safeReason ? ['skipped', safeReason] : ['skipped'],
      width,
    );
    return (
      <Box>
        <Text wrap="truncate-end">
          {leadingSlot}
          <Text color={t.textDim}>
            {skipped.head}
            {TITLE_SEP}
            {skipped.tail.join(SOFT_SEP)}
          </Text>
        </Text>
      </Box>
    );
  }

  const label = getMethodDisplay(method, t).text;
  const meta: string[] = [label];
  if (retries && retries > 0) meta.push(countNoun(retries, 'retry', 'retries'));
  if (duration != null) meta.push(formatDuration(duration));
  const tail = [safeFile, ...meta].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  const done = fitDetailRun(`T${index} ${safeTitle}`, tail, width);

  return (
    <Box>
      <Text wrap="truncate-end">
        {doneSlot}
        <Text color={t.text}>{done.head}</Text>
        {done.tail.length > 0 && (
          <Text color={t.textDim}>
            {TITLE_SEP}
            {done.tail.join(SOFT_SEP)}
          </Text>
        )}
      </Text>
    </Box>
  );
}
