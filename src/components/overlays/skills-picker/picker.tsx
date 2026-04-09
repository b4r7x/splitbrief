import { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../ui/theme.js';
import { OverlayPanel } from '../overlay-panel.js';
import type { SkillMeta } from '../../../types.js';
import { terminalSizeStore } from '../../../stores/terminal-size.js';
import { CURSOR, NO_CURSOR, filterByFields, computeScrollWindow } from '../../pickers/picker-utils.js';
import { skillsStore } from '../../../stores/skills.js';
import { overlayStore } from '../../../stores/overlay.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import { FilterInput } from '../../../ui/filter-input.js';
import { ScrollIndicator } from '../../../ui/scroll-indicator.js';
import { toSectionedList } from '../../../utils/sectioned-list.js';
import { truncate } from '../../../utils/format.js';

const filterSkill = (s: SkillMeta, query: string): boolean =>
  filterByFields(s, query, ['name', 'description']);

interface SkillRowProps {
  skill: SkillMeta;
  isCursor: boolean;
  isChecked: boolean;
  nameColWidth: number;
  descMaxWidth: number;
  theme: Theme;
}

function SkillRow({ skill, isCursor, isChecked, nameColWidth, descMaxWidth, theme: t }: SkillRowProps) {
  const name = truncate(skill.name, nameColWidth).padEnd(nameColWidth);
  const desc = truncate(skill.description, descMaxWidth);
  return (
    <Box>
      <Text color={isCursor ? t.accent : t.text}>{isCursor ? CURSOR : NO_CURSOR}</Text>
      <Text color={isChecked ? t.success : t.textDim}>{isChecked ? '[x] ' : '[ ] '}</Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
      <Text color={t.textDim}>{'  '}{desc}</Text>
    </Box>
  );
}

export function SkillsPicker() {
  const t = useTheme();
  const cols = terminalSizeStore.use(s => s.cols);
  const rows = terminalSizeStore.use(s => s.rows);
  const isSmall = terminalSizeStore.use(s => s.isSmall);
  const skills = skillsStore.use(s => s.available);
  const initial = skillsStore.use(s => s.selected);
  const [checked, setChecked] = useState<Set<string>>(new Set(initial));
  const [navigating, setNavigating] = useState(false);

  const sortedSkills = [
    ...skills.filter(s => s.scope === 'project'),
    ...skills.filter(s => s.scope === 'global'),
  ];

  const toggle = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    skillsStore.setSelected(checked);
    overlayStore.close();
  };

  const shouldAppendChar = (ch: string) => ch !== ' ' || !navigating;

  const list = useFilterableList<SkillMeta>({
    items: sortedSkills,
    filterFn: filterSkill,
    onSelect: handleConfirm,
    onClose: () => overlayStore.close(),
    shouldAppendChar,
    customKeys: (input, key, { filtered: current, selectedIndex: currentIndex }) => {
      if (key.upArrow || key.downArrow) {
        setNavigating(true);
        return false;
      }
      if (key.backspace || key.delete) {
        setNavigating(false);
        return false;
      }
      if (key.ctrl && input === 'a') {
        const ids = current.map(s => s.id);
        setChecked(prev => {
          const allChecked = ids.length > 0 && ids.every(id => prev.has(id));
          const next = new Set(prev);
          if (allChecked) {
            for (const id of ids) next.delete(id);
          } else {
            for (const id of ids) next.add(id);
          }
          return next;
        });
        return true;
      }
      if (input === ' ' && navigating) {
        const item = current[currentIndex];
        if (item) toggle(item.id);
        return true;
      }
      if (input && !key.ctrl && !key.meta && input !== ' ') {
        setNavigating(false);
      }
      return false;
    },
  });

  const { filter, filtered, selectedIndex } = list;

  const hintText = navigating
    ? 'Space toggle  Ctrl+A all  Enter confirm  Esc cancel'
    : '\u2191\u2193 to navigate  Ctrl+A all  Enter confirm  Esc cancel';

  const contentWidth = Math.min(cols - 4, isSmall ? 76 : 110);
  const nameColWidth = isSmall ? 20 : 26;
  const descMaxWidth = Math.max(10, contentWidth - 6 - nameColWidth - 2);

  if (skills.length === 0) {
    return (
      <OverlayPanel title="Planner Skills" hint="Esc close">
        <Text color={t.textDim}>  No skills found.</Text>
        <Text color={t.textDim}>  Add skills to .claude/skills/ or .tiny-spec/skills/ to get started.</Text>
      </OverlayPanel>
    );
  }

  const { scrollOffset, visibleSlice, showScrollUp, showScrollDown } =
    computeScrollWindow(filtered, selectedIndex, rows, 12, 5);

  const sectioned = toSectionedList(visibleSlice, (s) => s.scope);

  return (
    <OverlayPanel
      title={`Planner Skills (${checked.size} selected)`}
      hint={hintText}
      bordered={false}
    >
      <FilterInput filter={filter} />
      <ScrollIndicator show={showScrollUp} direction="up" />
      <Box flexDirection="column">
        {filtered.length === 0 && <Text color={t.textDim}>{'  No matching skills'}</Text>}
        {sectioned.map(({ item: skill, sectionHeader }, i) => {
          const globalIndex = scrollOffset + i;
          return (
            <Box key={skill.id} flexDirection="column">
              {sectionHeader && (
                <Box marginTop={i > 0 ? 1 : 0}>
                  <Text bold color={t.text}>{'  '}{sectionHeader === 'project' ? 'Project' : 'Global'}</Text>
                </Box>
              )}
              <SkillRow
                skill={skill}
                isCursor={globalIndex === selectedIndex}
                isChecked={checked.has(skill.id)}
                nameColWidth={nameColWidth}
                descMaxWidth={descMaxWidth}
                theme={t}
              />
            </Box>
          );
        })}
      </Box>
      <ScrollIndicator show={showScrollDown} direction="down" />
    </OverlayPanel>
  );
}
