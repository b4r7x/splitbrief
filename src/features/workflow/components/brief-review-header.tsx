import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { Task } from '../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../core/plan-review/types.js';
import type { BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import {
  buildPlanReviewScorecard,
  type PlanReviewScorecardEntry,
} from '../plan-review-scorecard.js';
import {
  formatPlanReviewSummary,
  formatQualityDisplay,
  formatTaskCount,
  sanitizeTaskDisplayText,
} from '../brief-review-format.js';

function getScorecardColor(
  entries: PlanReviewScorecardEntry[],
  theme: ReturnType<typeof useTheme>,
): string {
  if (
    entries.some(
      (entry) =>
        entry.count > 0 && (entry.bucket === 'splitOverflow' || entry.bucket === 'staleConflict'),
    )
  )
    return theme.error;
  if (entries.some((entry) => entry.count > 0 && entry.bucket !== 'ready')) return theme.warning;
  if (entries.some((entry) => entry.count > 0 && entry.bucket === 'ready')) return theme.success;
  return theme.textDim;
}

export function PlanReviewScorecardLine({
  tasks,
  quality,
  metadata,
}: {
  tasks: Task[];
  quality: BriefQualityReport | null;
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
}) {
  const t = useTheme();
  const scorecard = buildPlanReviewScorecard(tasks, quality, metadata);
  const text = scorecard.buckets.map((entry) => entry.label).join(' · ');

  return (
    <Text color={getScorecardColor(scorecard.buckets, t)} wrap="truncate">
      {text}
    </Text>
  );
}

export function PlanReviewHeader({
  tasks,
  quality,
  reviewMetadata,
  filePath,
}: {
  tasks: Task[];
  quality: BriefQualityReport | null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  filePath: string;
}) {
  const t = useTheme();
  const qualityDisplay = formatQualityDisplay(quality);
  const qualityColor = quality === null ? t.textDim : quality.passed ? t.success : t.error;
  const summary = sanitizeTaskDisplayText(formatPlanReviewSummary(tasks, reviewMetadata));
  const displayFilePath = sanitizeTaskDisplayText(filePath);

  return (
    <>
      <Box flexDirection="row" gap={2}>
        <Text bold color={t.accent}>
          Task Briefs
        </Text>
        <Text color={t.textDim}>{formatTaskCount(tasks.length)}</Text>
        <Text color={qualityColor}>{qualityDisplay}</Text>
      </Box>
      <Text color={t.textDim} wrap="truncate">
        {summary}
      </Text>
      <PlanReviewScorecardLine tasks={tasks} quality={quality} metadata={reviewMetadata} />
      <Text color={t.textDim} wrap="truncate">
        {displayFilePath}
      </Text>
    </>
  );
}
