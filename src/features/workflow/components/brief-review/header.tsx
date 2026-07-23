import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../../../components/separators.js';
import { useTheme } from '../../../../components/theme.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { BriefQualityReport } from '../../../../engine/spec/brief-quality.js';
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
  filePath,
  width,
  hasLoadError = false,
}: {
  tasks: Task[];
  quality: BriefQualityReport | null;
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

  const leftCells =
    getTerminalCellWidth('task briefs') +
    2 +
    getTerminalCellWidth(meta) +
    getTerminalCellWidth(qualityDisplay);
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
