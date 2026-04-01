import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SkillMeta } from '../types.js';
import type { Theme } from '../theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { computeScrollOffset, truncate } from './picker-utils.js';

interface SkillsPickerProps {
  skills: SkillMeta[];
  selected: Set<string>;
  onConfirm: (selected: Set<string>) => void;
  onClose: () => void;
  theme: Theme;
}

export function filterSkills(skills: SkillMeta[], filter: string): SkillMeta[] {
  if (!filter) return skills;
  const lower = filter.toLowerCase();
  return skills.filter(s =>
    s.name.toLowerCase().includes(lower) || s.description.toLowerCase().includes(lower),
  );
}

export function SkillsPicker({ skills, selected: initial, onConfirm, onClose, theme: t }: SkillsPickerProps) {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set(initial));
  const [navigating, setNavigating] = useState(false);
  const { cols, rows, isSmall } = useResponsiveLayout();

  const contentWidth = Math.min(cols - 4, isSmall ? 76 : 110);
  const nameColWidth = isSmall ? 20 : 26;
  const prefixWidth = 6; // "▸ " (2) + "[x] " (4)
  const gapWidth = 2;
  const descMaxWidth = Math.max(10, contentWidth - prefixWidth - nameColWidth - gapWidth);

  const filtered = filterSkills(skills, filter);
  const projectSkills = filtered.filter(s => s.scope === 'project');
  const globalSkills = filtered.filter(s => s.scope === 'global');
  const flatList = [...projectSkills, ...globalSkills];

  // Reserve: title(2) + filter(4) + footer(2) + scroll indicators(2) + section headers(2) = ~12
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
      if (allChecked) {
        ids.forEach(id => next.delete(id));
      } else {
        ids.forEach(id => next.add(id));
      }
      return next;
    });
  };

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.return) { onConfirm(checked); return; }
    if (key.upArrow) {
      setNavigating(true);
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : flatList.length - 1));
      return;
    }
    if (key.downArrow) {
      setNavigating(true);
      setSelectedIndex(prev => (prev < flatList.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.ctrl && input === 'a') {
      toggleAll();
      return;
    }
    if (input === ' ') {
      if (navigating && flatList.length > 0) {
        toggle(flatList[selectedIndex].id);
      } else {
        setFilter(prev => prev + ' ');
        setSelectedIndex(0);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setNavigating(false);
      setFilter(prev => prev.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setNavigating(false);
      setFilter(prev => prev + input);
      setSelectedIndex(0);
    }
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

  const globalOffset = projectSkills.length;
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < flatList.length;

  const renderRow = (skill: SkillMeta, globalIndex: number) => {
    const isCursor = globalIndex === selectedIndex;
    const isChecked = checked.has(skill.id);
    const cursor = isCursor ? '\u25b8 ' : '  ';
    const check = isChecked ? '[x] ' : '[ ] ';
    const name = truncate(skill.name, nameColWidth).padEnd(nameColWidth);
    const desc = truncate(skill.description, descMaxWidth);

    return (
      <Box key={skill.id}>
        <Text color={isCursor ? t.accent : t.text}>{cursor}</Text>
        <Text color={isChecked ? t.success : t.textDim}>{check}</Text>
        <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
        <Text color={t.textDim}>{'  '}{desc}</Text>
      </Box>
    );
  };

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

        {showScrollUp && (
          <Text color={t.textDim}>{'  \u2191 more'}</Text>
        )}

        <Box flexDirection="column">
          {visibleSlice.map((skill, i) => {
            const globalIndex = scrollOffset + i;
            const isFirstProject = globalIndex === 0 && projectSkills.length > 0;
            const isFirstGlobal = globalIndex === globalOffset && globalSkills.length > 0;

            return (
              <React.Fragment key={skill.id}>
                {isFirstProject && (
                  <Box marginBottom={0}>
                    <Text bold color={t.text}>{'  Project'}</Text>
                  </Box>
                )}
                {isFirstGlobal && (
                  <Box marginTop={projectSkills.length > 0 ? 1 : 0}>
                    <Text bold color={t.text}>{'  Global'}</Text>
                  </Box>
                )}
                {renderRow(skill, globalIndex)}
              </React.Fragment>
            );
          })}
          {flatList.length === 0 && (
            <Text color={t.textDim}>{'  No matching skills'}</Text>
          )}
        </Box>

        {showScrollDown && (
          <Text color={t.textDim}>{'  \u2193 more'}</Text>
        )}
      </Box>

      <Box flexGrow={1} />

      <Box justifyContent="center" paddingBottom={1}>
        <Text color={t.textDim}>{navigating ? 'Space toggle  Ctrl+A all  Enter confirm  Esc cancel' : '\u2191\u2193 to navigate  Ctrl+A all  Enter confirm  Esc cancel'}</Text>
      </Box>
    </Box>
  );
}
