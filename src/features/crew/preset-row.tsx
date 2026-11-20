import { Box } from 'ink';
import { ListRow } from '../../components/list-row/row.js';
import { planListRows, type ListLine, type ListRowModel } from '../../components/list-row/plan.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool/catalog.js';
import { SOFT_SEP } from '../../core/separators.js';

export function planPresetRows(presets: readonly CrewPreset[], width: number, compact = false) {
  const rows = presets.map((preset): ListRowModel => {
    const needs = preset.notReady.map((tool) => CLI_TOOL_CATALOG[tool].displayName);
    return {
      name: preset.label,
      nameParts: [{ text: preset.label, tone: needs.length ? 'textDim' : 'text' }],
      trailing: compact && needs.length ? 'Unavailable' : undefined,
      description: compact
        ? undefined
        : needs.length
          ? 'Unavailable' + SOFT_SEP + 'needs ' + needs.join(', ')
          : preset.description,
    };
  });
  return planListRows(rows, { width });
}

export function PresetRowView({
  lines,
  isCursor,
  width,
}: {
  lines: readonly ListLine[];
  isCursor: boolean;
  width: number;
}) {
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line) => (
        <ListRow key={line.part} line={line} selected={isCursor} width={width} />
      ))}
    </Box>
  );
}
