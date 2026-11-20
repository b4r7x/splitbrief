import { planListRows, type ListRowModel } from '../../components/list-row/plan.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool/catalog.js';
import { SOFT_SEP } from '../../core/separators.js';
import { padTerminalDisplayTextEnd } from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { listRowLead } from '../../components/list-row/lead.js';
import { CREW_COLUMN_GAP } from './format.js';

const UNAVAILABLE = `${CREW_COLUMN_GAP}Unavailable`;

export function planPresetRows(
  presets: readonly CrewPreset[],
  width: number,
  options: { focusedId?: string | undefined; compact?: boolean } = {},
) {
  const room = width - getTerminalCellWidth(listRowLead('default'));
  const labelWidth = Math.max(0, ...presets.map(({ label }) => getTerminalCellWidth(label)));
  const rows = presets.map((preset): ListRowModel => {
    if (preset.notReady.length === 0) {
      return {
        name: preset.label,
        nameParts: [{ text: preset.label, tone: 'text' }],
        description: options.compact ? undefined : preset.description,
      };
    }
    const reason = `needs ${preset.notReady.map((tool) => CLI_TOOL_CATALOG[tool].displayName).join(', ')}`;
    const status = labelWidth + getTerminalCellWidth(UNAVAILABLE) <= room ? UNAVAILABLE : '';
    const label = status ? padTerminalDisplayTextEnd(preset.label, labelWidth) : preset.label;
    const focused = preset.id === options.focusedId;
    const inlineReason = SOFT_SEP + reason;
    const detail =
      !focused && status && getTerminalCellWidth(label + status + inlineReason) <= room
        ? inlineReason
        : '';
    return {
      group: 'unavailable',
      name: label + status + detail,
      nameParts: [
        { text: label, tone: 'textDim' },
        { text: status, tone: 'warning' },
        { text: detail, tone: 'textDim' },
      ],
      description: focused ? reason : undefined,
      descriptionBelow: Boolean(status),
    };
  });
  return planListRows(rows, { width });
}
