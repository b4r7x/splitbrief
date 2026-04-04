import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import type { Theme } from './theme.js';
import { PickerShell } from './picker-shell.js';
import { truncate } from '../utils/format.js';

export interface PlannerOption {
  name: string;
  type: 'cli' | 'api';
  version?: string | null;
  available: boolean;
}

export interface PlannerPickerProps {
  planners: PlannerOption[];
  onSelect: (planner: { name: string; type: 'cli' | 'api' }) => void;
  onCancel: () => void;
}

interface PlannerRowProps {
  item: PlannerOption;
  isCursor: boolean;
  nameWidth: number;
  theme: Theme;
}

function PlannerRow({ item, isCursor, nameWidth, theme: t }: PlannerRowProps) {
  const cursor = isCursor ? '\u25b8 ' : '  ';
  const name = truncate(item.name, nameWidth).padEnd(nameWidth);
  const versionLabel = item.version ? ` v${item.version}` : '';
  const typeLabel = item.type === 'cli' ? 'CLI' : 'API';
  const availColor = item.available ? t.success : t.textDim;
  const availLabel = item.available ? '\u2713' : '\u2717';

  return (
    <Box>
      <Text color={isCursor ? t.accent : t.text}>{cursor}</Text>
      <Text color={availColor}>{availLabel} </Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
      <Text color={t.textDim}>  {typeLabel}{versionLabel}</Text>
    </Box>
  );
}

function filterPlanner(item: PlannerOption, query: string): boolean {
  const lower = query.toLowerCase();
  return item.name.toLowerCase().includes(lower);
}

export function PlannerPicker({ planners, onSelect, onCancel }: PlannerPickerProps) {
  const t = useTheme();

  const available = planners.filter((p) => p.available);
  const unavailable = planners.filter((p) => !p.available);

  return (
    <PickerShell
      title="Select Planner"
      items={available}
      filterFn={filterPlanner}
      getKey={(item) => item.name}
      renderRow={(item, isSelected) => (
        <PlannerRow item={item} isCursor={isSelected} nameWidth={28} theme={t} />
      )}
      onSelect={(item) => onSelect({ name: item.name, type: item.type })}
      onCancel={onCancel}
      emptyText="No planner backends detected."
      emptyHint="Install claude-code, codex, opencode, aider, or agent-sdk."
      extraContent={unavailable.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.textDim} dimColor>  Unavailable:</Text>
          {unavailable.map((p) => (
            <Text key={p.name} color={t.textDim} dimColor>    {p.name}</Text>
          ))}
        </Box>
      ) : undefined}
    />
  );
}
