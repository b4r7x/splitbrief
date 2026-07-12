import { Text } from 'ink';
import { formatStageLabel } from '../../../core/phase-display.js';
import { formatTime } from '../../../utils/format-time.js';
import { LabeledRow } from '../../../components/labeled-row.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import type { Theme } from '../../../components/theme.js';

export function buildPhaseTimingRows(
  phaseTimings: Record<string, number>,
  labelWidth: number,
  theme: Theme,
): ScrollableDocumentRow[] {
  const phases = Object.entries(phaseTimings);
  if (phases.length === 0) return [];

  const rows: ScrollableDocumentRow[] = [
    {
      key: 'phase-heading',
      node: <Text color={theme.textDim}>Phase breakdown</Text>,
    },
  ];

  for (const [phase, duration] of phases) {
    rows.push({
      key: `phase:${phase}`,
      node: (
        <LabeledRow label={formatStageLabel(phase)} labelWidth={labelWidth}>
          <Text color={theme.textDim}>{formatTime(duration)}</Text>
        </LabeledRow>
      ),
    });
  }

  return rows;
}
