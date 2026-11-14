import { Box } from 'ink';
import { leadingWith } from './detail-run.js';
import { type TaskSummaryState, type TaskSummaryProps, taskSummarySpans } from './spans.js';
import { TextSpans } from '../../../../components/text-spans.js';
import { useTheme, ThemeText as Text } from '../../../../components/theme.js';
import type { TaskCompletionMethod } from '../../../../core/schemas/enums.js';
import { classifyTaskCompletionMethod } from '../../../../core/task-completion.js';
import type { Theme } from '../../../../core/theme/palette.js';
import { type GlyphName, glyph } from '../../../../lib/glyphs.js';

interface MarkerSpec {
  name: GlyphName;
  color: string | undefined;
}

function settledMarker(method: TaskCompletionMethod, t: Theme): MarkerSpec {
  if (method === 'failed') return { name: 'statusFailed', color: t.error };
  if (method === 'skipped') return { name: 'statusSkipped', color: t.textDim };
  // A brief that needed a bigger seat did not pass on the one it was given, and the sidebar says so
  // with the same triangle in warning.
  if (classifyTaskCompletionMethod(method) === 'escalated') {
    return { name: 'statusEscalated', color: t.warning };
  }
  return { name: 'stageDone', color: t.success };
}

function markerSpec(state: TaskSummaryState, t: Theme): MarkerSpec {
  if (state.kind === 'pending') return { name: 'statusPending', color: t.textDim };
  if (state.kind === 'stage') {
    if (state.outcome === 'stopped') return { name: 'statusCancelled', color: t.warning };
    return state.outcome === 'failed' || state.outcome === 'no-verdict'
      ? { name: 'statusFailed', color: t.error }
      : { name: 'stageDone', color: t.success };
  }
  if (state.kind === 'halted') {
    return state.tone === 'failed'
      ? { name: 'statusFailed', color: t.error }
      : { name: 'statusCancelled', color: t.warning };
  }
  return settledMarker(state.method, t);
}

export function TaskSummary(props: TaskSummaryProps) {
  const { state, focused } = props;
  const t = useTheme();
  const marker = markerSpec(state, t);
  // One leading for every row kind — the transcript's padding then the marker slot — so a settled
  // brief and a pending one line their marks up in the same column, and that column is the one the
  // live transcript uses.
  //
  // Focus paints the bar into the padding cell and keeps the mark, the way a focused transcript row
  // does, so the mark never leaves the line. The bar is `text`, not `accent`: this glyph also marks
  // the live row in the sidebar and the focused row in the transcript, and one glyph wearing three
  // colours across three panes reads as three different affordances.
  const leading = leadingWith(glyph(marker.name));
  const markerSlot =
    focused === true ? (
      <Text>
        <Text color={t.text} bold>
          {glyph('liveBar')}
        </Text>
        <Text color={marker.color}>{leading.slice(1)}</Text>
      </Text>
    ) : (
      <Text color={marker.color}>{leading}</Text>
    );

  return (
    <Box>
      <Text wrap="truncate-end">
        {markerSlot}
        <TextSpans parts={taskSummarySpans(props)} />
      </Text>
    </Box>
  );
}
