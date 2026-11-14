import { Box } from 'ink';
import type { WorkflowTask } from '../../../../core/run-view/briefs.js';
import { glyph, type GlyphName } from '../../../../lib/glyphs.js';
import { useTheme, ThemeText as Text } from '../../../../components/theme.js';
import type { RailHalt } from '../../../../core/phases/rail.js';
import { taskRowLabel } from '../../../../core/run-view/brief-labels.js';
import type { Theme } from '../../../../core/theme/palette.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { routeBriefMark } from '../../at-rest.js';
import { getSidebarTaskTitleWidth } from '../../layout/rect.js';

interface RowSpec {
  bar: string;
  marker: string;
  markerColor: string | undefined;
  labelColor: string | undefined;
  bold: boolean;
  tail?: { text: string; color: string | undefined };
}

const TASK_STATUS_GLYPH_NAME: Record<WorkflowTask['status'], GlyphName> = {
  done: 'stageDone',
  failed: 'statusFailed',
  escalated: 'statusEscalated',
  in_progress: 'statusInProgress',
  pending: 'statusPending',
  skipped: 'statusSkipped',
};

function statusGlyph(status: WorkflowTask['status']): string {
  return glyph(TASK_STATUS_GLYPH_NAME[status]);
}

function rowSpec(status: WorkflowTask['status'], t: Theme, restMark: RailHalt | null): RowSpec {
  switch (status) {
    case 'done':
      return {
        bar: ' ',
        marker: statusGlyph('done'),
        markerColor: t[stateTone('passed')],
        labelColor: t.textDim,
        bold: false,
      };
    case 'in_progress':
      return {
        bar: glyph('liveBar'),
        marker:
          restMark === null
            ? statusGlyph('in_progress')
            : glyph(restMark === 'failed' ? 'statusFailed' : 'statusCancelled'),
        markerColor:
          t[
            stateTone(
              restMark === null ? 'running' : restMark === 'failed' ? 'failed' : 'attention',
            )
          ],
        labelColor: t.text,
        bold: true,
      };
    case 'pending':
      return {
        bar: ' ',
        marker: statusGlyph('pending'),
        markerColor: t[stateTone('pending')],
        labelColor: t.textDim,
        bold: false,
      };
    case 'escalated':
      return {
        bar: ' ',
        marker: statusGlyph('escalated'),
        markerColor: t[stateTone('attention')],
        labelColor: t.text,
        bold: false,
        tail: { text: 'escalated', color: t[stateTone('attention')] },
      };
    case 'failed':
      return {
        bar: ' ',
        marker: statusGlyph('failed'),
        markerColor: t[stateTone('failed')],
        labelColor: t.text,
        bold: false,
        tail: { text: 'failed', color: t[stateTone('failed')] },
      };
    case 'skipped':
      return {
        bar: ' ',
        marker: statusGlyph('skipped'),
        markerColor: t.textDim,
        labelColor: t.textDim,
        bold: false,
        tail: { text: 'skipped', color: t.textDim },
      };
    default:
      return assertNever(status);
  }
}

export function TaskRow({
  task,
  width,
  statusCells,
}: {
  task: WorkflowTask;
  width: number;
  statusCells: number;
}) {
  const t = useTheme();
  const restMark = routerStore.use(routeBriefMark);
  const spec = rowSpec(task.status, t, restMark);
  const titleCells = getSidebarTaskTitleWidth({ width, reservedTailCells: statusCells });
  const taskLabel = taskRowLabel(task, titleCells);
  return (
    <Box>
      <Text color={spec.labelColor} bold={spec.bold}>
        {spec.bar}
      </Text>
      <Text color={spec.markerColor} bold={spec.bold}>
        {spec.marker}{' '}
      </Text>
      <Box width={titleCells} flexShrink={0}>
        <Text color={spec.labelColor} bold={spec.bold}>
          {taskLabel}
        </Text>
      </Box>
      {spec.tail && <Text color={spec.tail.color}>{`  ${spec.tail.text}`}</Text>}
    </Box>
  );
}
