import { planListRows, type ListRowModel } from '../../components/list-row/plan.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool/catalog.js';
import { SOFT_SEP } from '../../core/separators.js';

const UNAVAILABLE = 'Unavailable';

export function planPresetRows(
  presets: readonly CrewPreset[],
  width: number,
  options: { focusedId: string | undefined; compact?: boolean },
) {
  const reasons = presets.map(({ notReady }) =>
    notReady.length === 0
      ? undefined
      : `needs ${notReady.map((tool) => CLI_TOOL_CATALOG[tool].displayName).join(', ')}`,
  );
  const plan = (inline: boolean) =>
    planListRows(
      presets.map((preset, index): ListRowModel => {
        const reason = reasons[index];
        return {
          name: preset.label,
          keepWhole: 'label',
          nameParts: [{ text: preset.label, tone: reason === undefined ? 'text' : 'textDim' }],
          description:
            reason === undefined
              ? options.compact
                ? undefined
                : preset.description
              : inline
                ? UNAVAILABLE + SOFT_SEP + reason
                : UNAVAILABLE,
        };
      }),
      { width, nameColumnLimit: width },
    );

  const inline = plan(true);
  if (!inline.some((line) => line.part > 0 && reasons[line.row] !== undefined)) {
    return { lines: inline, spareRows: 0 };
  }

  const lines = plan(false);
  const focused = presets.findIndex((preset) => preset.id === options.focusedId);
  const reason = reasons[focused];
  if (reason === undefined) return { lines, spareRows: 1 };

  const detail = planListRows([{ name: reason, nameParts: [{ text: reason, tone: 'textDim' }] }], {
    width,
  });
  return {
    lines: lines.flatMap((line, index) =>
      line.row === focused && lines[index + 1]?.row !== focused
        ? [line, ...detail.map((row) => ({ ...row, row: focused, part: line.part + 1 }))]
        : [line],
    ),
    spareRows: 0,
  };
}
