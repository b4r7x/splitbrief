import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../../../components/separators.js';
import { useTheme } from '../../../../components/theme.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { BriefQualityReport } from '../../../../engine/spec/brief-quality.js';
import type { BriefReadinessGateReport } from '../../../../engine/orchestrator/planning/brief-readiness-gate.js';
import {
  formatQualityDisplay,
  formatTaskCount,
  sanitizeTaskDisplayText,
} from '../../brief-review-format.js';

const NARROW_COLLAPSE_WIDTH = 50;
const MIN_FILEPATH_CELLS = 8;

export function PlanReviewHeader({
  tasks,
  quality,
  readiness,
  filePath,
  width,
  hasLoadError = false,
}: {
  tasks: Task[];
  quality: BriefQualityReport | null;
  readiness: BriefReadinessGateReport | null;
  filePath: string;
  width: number;
  hasLoadError?: boolean | undefined;
}) {
  const t = useTheme();
  const countText = hasLoadError ? '—' : formatTaskCount(tasks.length);
  const qualityDisplay = formatQualityDisplay(quality);
  const qualityColor = quality !== null && !quality.passed ? t.error : t.textDim;
  const meta = `${countText}${SOFT_SEP}`;
  const displayFilePath = sanitizeTaskDisplayText(filePath);
  const blockedCount = readiness !== null && !readiness.ok ? readiness.blocks.length : 0;
  const readinessDisplay = blockedCount > 0 ? `readiness ${blockedCount} blocked` : '';
  const overrideDisplay = readiness !== null && !readiness.ok ? 'approve again overrides' : '';

  const leftCells =
    getTerminalCellWidth('task briefs') +
    2 +
    getTerminalCellWidth(meta) +
    getTerminalCellWidth(qualityDisplay) +
    (readinessDisplay !== '' ? getTerminalCellWidth(readinessDisplay) + 2 : 0) +
    (overrideDisplay !== '' ? getTerminalCellWidth(overrideDisplay) + 2 : 0);
  const filePathBudget = width - leftCells - 2;
  const showFilePath =
    displayFilePath !== '' &&
    width >= NARROW_COLLAPSE_WIDTH &&
    filePathBudget >= MIN_FILEPATH_CELLS;
  const filePathText = showFilePath
    ? truncateTerminalDisplayTextMiddle(displayFilePath, filePathBudget)
    : '';

  return (
    <Box flexDirection="row" width={width} overflow="hidden">
      <Text bold color={t.text}>
        task briefs
      </Text>
      <Text>{'  '}</Text>
      <Text color={t.textDim}>{meta}</Text>
      <Text color={qualityColor}>{qualityDisplay}</Text>
      {readinessDisplay !== '' && (
        <Text color={t.warning} wrap="truncate">
          {' '}
          {readinessDisplay}
        </Text>
      )}
      {overrideDisplay !== '' && (
        <Text color={t.textDim} wrap="truncate">
          {' '}
          {overrideDisplay}
        </Text>
      )}
      {showFilePath && (
        <>
          <Box flexGrow={1} />
          <Text color={t.textDim} wrap="truncate">
            {filePathText}
          </Text>
        </>
      )}
    </Box>
  );
}
