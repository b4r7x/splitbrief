import { Fragment, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../ui/theme.js';
import type { SkillMeta } from '../types.js';
import type { Theme } from '../ui/theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { useFilterableList } from '../hooks/use-filterable-list.js';
import { truncate } from '../utils/format.js';
import { computeScrollOffset } from '../ui/picker-utils.js';

interface SkillsPickerProps {
  skills: SkillMeta[];
  selected: Set<string>;
  onConfirm: (selected: Set<string>) => void;
  onClose: () => void;
}

interface SkillRowProps {
  skill: SkillMeta;
  isCursor: boolean;
  isChecked: boolean;
  nameColWidth: number;
  descMaxWidth: number;
  theme: Theme;
}

function SkillRow({ skill, isCursor, isChecked, nameColWidth, descMaxWidth, theme: t }: SkillRowProps) {
  const cursor = isCursor ? '\u25b8 ' : '  ';
  const check = isChecked ? '[x] ' : '[ ] ';
  const name = truncate(skill.name, nameColWidth).padEnd(nameColWidth);
  const desc = truncate(skill.description, descMaxWidth);

  return (
    <Box>
      <Text color={isCursor ? t.accent : t.text}>{cursor}</Text>
      <Text color={isChecked ? t.success : t.textDim}>{check}</Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
      <Text color={t.textDim}>{'  '}{desc}</Text>
    </Box>
  );
}

interface SectionEntry {
  skill: SkillMeta;
  globalIndex: number;
  sectionHeader?: 'Project' | 'Global';
  sectionGap?: boolean;
}

function buildSectionEntries(
  visibleSlice: SkillMeta[],
  scrollOffset: number,
  projectCount: number,
  globalCount: number,
): SectionEntry[] {
  const globalOffset = projectCount;
  return visibleSlice.map((skill, i) => {
    const globalIndex = scrollOffset + i;
    const entry: SectionEntry = { skill, globalIndex };
    if (globalIndex === 0 && projectCount > 0) entry.sectionHeader = 'Project';
    if (globalIndex === globalOffset && globalCount > 0) {
      entry.sectionHeader = 'Global';
      entry.sectionGap = projectCount > 0;
    }
    return entry;
  });
}

function filterSkill(s: SkillMeta, query: string): boolean {
  const lower = query.toLowerCase();
  return s.name.toLowerCase().includes(lower) || s.description.toLowerCase().includes(lower);
}

export function SkillsPicker({ skills, selected: initial, onConfirm, onClose }: SkillsPickerProps) {
  const t = useTheme();
  const [checked, setChecked] = useState<Set<string>>(new Set(initial));
  const [navigating, setNavigating] = useState(false);
  const { cols, rows, isSmall } = useResponsiveLayout();

  const { filter, setFilter, filtered, selectedIndex } = useFilterableList({
    items: skills,
    filterFn: filterSkill,
    onSelect: () => onConfirm(checked),
  });

  const contentWidth = Math.min(cols - 4, isSmall ? 76 : 110);
  const nameColWidth = isSmall ? 20 : 26;
  const prefixWidth = 6;
  const gapWidth = 2;
  const descMaxWidth = Math.max(10, contentWidth - prefixWidth - nameColWidth - gapWidth);

  const projectSkills = filtered.filter(s => s.scope === 'project');
  const globalSkills = filtered.filter(s => s.scope === 'global');
  const flatList = [...projectSkills, ...globalSkills];

  const maxVisible = Math.max(rows - 12, 5);
  const scrollOffset = computeScrollOffset(selectedIndex, maxVisible, flatList.length);
  const visibleSlice = flatList.slice(scrollOffset, scrollOffset + maxVisible);

  const toggle = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setChecked(prev => {
      const ids = flatList.map(s => s.id);
      const allChecked = ids.length > 0 && ids.every(id => prev.has(id));
      const next = new Set(prev);
      if (allChecked) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  };

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) { setNavigating(true); return; }
    if (key.backspace || key.delete) { setNavigating(false); return; }
    if (key.ctrl && input === 'a') { toggleAll(); return; }
    if (input === ' ' && navigating && flatList.length > 0) {
      toggle(flatList[selectedIndex].id);
      // Strip the trailing space the hook's useInput will append
      setTimeout(() => setFilter(filter.trimEnd()), 0);
      return;
    }
    if (input && !key.ctrl && !key.meta && input !== ' ') setNavigating(false);
  });

  if (skills.length === 0) {
    return (
      <Box flexDirection="column" width={cols} height={rows} alignItems="center" justifyContent="center">
        <Box flexDirection="column" width={contentWidth}>
          <Box justifyContent="center" marginBottom={1}>
            <Text bold color={t.accent}>Planner Skills</Text>
          </Box>
          <Text color={t.textDim}>  No skills found.</Text>
          <Text color={t.textDim}>  Add skills to .claude/skills/ or .tiny-spec/skills/ to get started.</Text>
          <Box justifyContent="center" marginTop={1}>
            <Text color={t.textDim}>Esc close</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < flatList.length;
  const entries = buildSectionEntries(visibleSlice, scrollOffset, projectSkills.length, globalSkills.length);

  return (
    <Box flexDirection="column" width={cols} height={rows} alignItems="center" paddingTop={1}>
      <Box flexDirection="column" width={contentWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>Planner Skills</Text>
          <Text color={t.textDim}>{' ('}{checked.size}{' selected)'}</Text>
        </Box>

        <Box borderStyle="round" borderColor={t.border} paddingX={1} marginBottom={1} width={contentWidth}>
          <Text color={t.accent}>{'> '}</Text>
          <Text>{filter || <Text color={t.textDim}>Type to filter...</Text>}</Text>
        </Box>

        {showScrollUp && <Text color={t.textDim}>{'  \u2191 more'}</Text>}

        <Box flexDirection="column">
          {entries.map(({ skill, globalIndex, sectionHeader, sectionGap }) => (
            <Fragment key={skill.id}>
              {sectionHeader && (
                <Box marginTop={sectionGap ? 1 : 0} marginBottom={0}>
                  <Text bold color={t.text}>{'  '}{sectionHeader}</Text>
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
            </Fragment>
          ))}
          {flatList.length === 0 && <Text color={t.textDim}>{'  No matching skills'}</Text>}
        </Box>

        {showScrollDown && <Text color={t.textDim}>{'  \u2193 more'}</Text>}
      </Box>

      <Box flexGrow={1} />

      <Box justifyContent="center" paddingBottom={1}>
        <Text color={t.textDim}>{navigating ? 'Space toggle  Ctrl+A all  Enter confirm  Esc cancel' : '\u2191\u2193 to navigate  Ctrl+A all  Enter confirm  Esc cancel'}</Text>
      </Box>
    </Box>
  );
}
