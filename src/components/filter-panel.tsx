import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';
import { truncate } from '../utils/format.js';
import type { Theme } from '../ui/theme.js';

export interface PickerItem {
  id: string;
  label: string;
  sublabel: string;
  isSentinel?: boolean;
}

export function filterItem(item: PickerItem, query: string): boolean {
  const lower = query.toLowerCase();
  return item.label.toLowerCase().includes(lower) || item.sublabel.toLowerCase().includes(lower);
}

interface ItemRowProps {
  item: PickerItem;
  isCursor: boolean;
  isSelected: boolean;
  nameWidth: number;
  sublabelWidth: number;
  theme: Theme;
}

function ItemRow({ item, isCursor, isSelected, nameWidth, sublabelWidth, theme: t }: ItemRowProps) {
  const cursor = isCursor ? '\u25b8 ' : '  ';
  const radio = item.isSentinel ? '  ' : isSelected ? '(*) ' : '( ) ';
  const name = truncate(item.label, nameWidth).padEnd(nameWidth);
  const sub = item.sublabel ? truncate(item.sublabel, sublabelWidth) : '';

  return (
    <Box>
      <Text color={isCursor ? t.accent : (item.isSentinel ? t.textDim : t.text)}>{cursor}</Text>
      <Text color={isSelected ? t.success : t.textDim}>{radio}</Text>
      <Text color={isCursor ? t.accent : (item.isSentinel ? t.textDim : t.text)} bold={isCursor}>{name}</Text>
      {sub && <Text color={t.textDim}>{'  '}{sub}</Text>}
    </Box>
  );
}

interface FilterPanelProps {
  title: string;
  items: PickerItem[];
  filter: string;
  selectedIndex: number;
  scrollOffset: number;
  maxVisible: number;
  isActive: boolean;
  width: number;
  nameWidth: number;
  sublabelWidth: number;
  emptyText?: string;
  selectedId?: string | null;
}

export function FilterPanel({
  title,
  items,
  filter,
  selectedIndex,
  scrollOffset,
  maxVisible,
  isActive,
  width,
  nameWidth,
  sublabelWidth,
  emptyText = 'No items detected',
  selectedId,
}: FilterPanelProps) {
  const t = useTheme();

  const visible = items.slice(scrollOffset, scrollOffset + maxVisible);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxVisible < items.length;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={isActive ? t.accent : t.border}
      paddingX={1}
    >
      <Box>
        <Text bold color={isActive ? t.accent : t.text}>{title}</Text>
      </Box>

      <Box borderStyle="round" borderColor={isActive ? t.accent : t.border} paddingX={1}>
        <Text color={isActive ? t.accent : t.textDim}>{'> '}</Text>
        <Text>
          {isActive
            ? (filter || <Text color={t.textDim}>Type to filter...</Text>)
            : <Text color={t.textDim}>{filter || 'Type to filter...'}</Text>}
        </Text>
      </Box>

      {hasScrollUp && <Text color={t.textDim}>{'  \u2191 more'}</Text>}

      <Box flexDirection="column" flexGrow={1}>
        {visible.map((item, i) => {
          const globalIndex = scrollOffset + i;
          return (
            <ItemRow
              key={item.id}
              item={item}
              isCursor={isActive && globalIndex === selectedIndex}
              isSelected={item.id === selectedId}
              nameWidth={nameWidth}
              sublabelWidth={sublabelWidth}
              theme={t}
            />
          );
        })}
        {items.length === 0 && <Text color={t.textDim}>{'  '}{emptyText}</Text>}
      </Box>

      {hasScrollDown && <Text color={t.textDim}>{'  \u2193 more'}</Text>}
    </Box>
  );
}
