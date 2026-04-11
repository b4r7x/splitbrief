import { Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import type { CommandPaletteItem, Screen } from '../../types.js';
import { terminalSizeStore } from '../../stores/terminal-size.js';
import { truncate } from '../../utils/format.js';
import { filterByFields } from '../pickers/picker-utils.js';
import { overlayStore } from '../../stores/overlay.js';
import { FilterableList } from '../pickers/filterable-list.js';

interface CommandPaletteProps {
  items: CommandPaletteItem[];
  currentScreen: Screen;
}

const filterPaletteItem = (item: CommandPaletteItem, query: string) =>
  filterByFields(item, query, ['label', 'description']);

export function CommandPalette({ items, currentScreen }: CommandPaletteProps) {
  const t = useTheme();
  const isSmall = terminalSizeStore.use(s => s.isSmall);

  const maxWidth = isSmall ? 60 : 80;
  const nameColWidth = isSmall ? 14 : 18;
  const shortcutMaxWidth = 10;
  const descMaxWidth = Math.max(10, maxWidth - 2 - nameColWidth - 2 - shortcutMaxWidth);

  const screenItems = items.filter((item) => item.availableOn.includes(currentScreen));

  return (
    <FilterableList
      title="Command Palette"
      hint={'\u2191\u2193 navigate  Enter select  Esc close'}
      items={screenItems}
      filterFn={filterPaletteItem}
      getKey={(item) => item.label}
      onConfirm={(item) => { overlayStore.close(); item.action(); }}
      width={maxWidth}
      bordered={false}
      chromeRows={12}
      maxVisible={5}
      placeholder={<Text color={t.textDim}>  No matching commands</Text>}
      renderItem={(item, { isCursor }) => {
        const name = truncate(item.label, nameColWidth).padEnd(nameColWidth);
        const desc = truncate(item.description, descMaxWidth);
        const shortcut = item.shortcut ? truncate(`[${item.shortcut}]`, shortcutMaxWidth) : '';

        return (
          <>
            <Text color={isCursor ? t.accent : t.text}>
              {isCursor ? '\u25b8 ' : '  '}
            </Text>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
            <Text color={t.textDim}>{'  '}{desc}</Text>
            {shortcut && <Text color={t.textDim}> {shortcut}</Text>}
          </>
        );
      }}
    />
  );
}
