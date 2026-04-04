import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import type { Theme } from './theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { PickerShell } from './picker-shell.js';
import { truncate } from '../utils/format.js';

export interface ProviderGroup {
  name: string;
  models: string[];
  isLocal: boolean;
}

interface FlatModel {
  provider: string;
  model: string;
  isLocal: boolean;
}

export interface ModelPickerProps {
  providers: ProviderGroup[];
  onSelect: (provider: string, model: string) => void;
  onCancel: () => void;
}

interface ModelRowProps {
  item: FlatModel;
  isCursor: boolean;
  nameWidth: number;
  providerWidth: number;
  theme: Theme;
}

function ModelRow({ item, isCursor, nameWidth, providerWidth, theme: t }: ModelRowProps) {
  const cursor = isCursor ? '\u25b8 ' : '  ';
  const name = truncate(item.model, nameWidth).padEnd(nameWidth);
  const provider = truncate(item.provider, providerWidth).padEnd(providerWidth);
  const badge = item.isLocal ? ' local' : '';

  return (
    <Box>
      <Text color={isCursor ? t.accent : t.text}>{cursor}</Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
      <Text color={t.textDim}>{'  '}{provider}</Text>
      {badge && <Text color={t.success}>{badge}</Text>}
    </Box>
  );
}

function flattenProviders(providers: ProviderGroup[]): FlatModel[] {
  const items: FlatModel[] = [];
  for (const p of providers) {
    for (const model of p.models) {
      items.push({ provider: p.name, model, isLocal: p.isLocal });
    }
  }
  return items;
}

function filterModel(item: FlatModel, query: string): boolean {
  const lower = query.toLowerCase();
  return item.model.toLowerCase().includes(lower) || item.provider.toLowerCase().includes(lower);
}

export function ModelPicker({ providers, onSelect, onCancel }: ModelPickerProps) {
  const t = useTheme();
  const { isSmall } = useResponsiveLayout();
  const items = flattenProviders(providers);

  const providerWidth = isSmall ? 12 : 16;
  const contentWidth = isSmall ? 72 : 106;
  const nameWidth = Math.max(10, contentWidth - providerWidth - 10);

  return (
    <PickerShell
      title="Select Model"
      items={items}
      filterFn={filterModel}
      getKey={(item) => `${item.provider}-${item.model}`}
      renderRow={(item, isSelected) => (
        <ModelRow item={item} isCursor={isSelected} nameWidth={nameWidth} providerWidth={providerWidth} theme={t} />
      )}
      onSelect={(item) => onSelect(item.provider, item.model)}
      onCancel={onCancel}
      emptyText="No models found."
      emptyHint="Start Ollama or LM Studio to detect models."
    />
  );
}
