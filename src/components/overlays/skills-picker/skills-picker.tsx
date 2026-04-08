import { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme, type Theme } from '../../../ui/theme.js';
import { OverlayPanel } from '../overlay-panel.js';
import type { SkillMeta } from '../../../types.js';
import { useResponsiveLayout } from '../../../hooks/use-terminal-size.js';
import { CURSOR, NO_CURSOR, filterByFields } from '../../../ui/picker-utils.js';
import { skillsStore } from '../../../stores/skills.js';
import { overlayStore } from '../../../stores/overlay.js';
import { FilterableList } from '../../pickers/filterable-list.js';
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
  const { cols, isSmall } = useResponsiveLayout();
  const skills = skillsStore.use(s => s.available);
  const initial = skillsStore.use(s => s.selected);
  const [checked, setChecked] = useState<Set<string>>(new Set(initial));
  const [navigating, setNavigating] = useState(false);
  const filteredRef = useRef<{ filtered: SkillMeta[]; cursor: number }>({ filtered: [], cursor: 0 });

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

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) { setNavigating(true); return; }
    if (key.backspace || key.delete) { setNavigating(false); return; }
    if (key.ctrl && input === 'a') {
      const { filtered } = filteredRef.current;
      setChecked(prev => {
        const ids = filtered.map(s => s.id);
        const allChecked = ids.length > 0 && ids.every(id => prev.has(id));
        const next = new Set(prev);
        if (allChecked) ids.forEach(id => next.delete(id));
        else ids.forEach(id => next.add(id));
        return next;
      });
      return;
    }
    if (input === ' ' && navigating) {
      const { filtered, cursor } = filteredRef.current;
      if (filtered.length > 0) toggle(filtered[cursor].id);
      return;
    }
    if (input && !key.ctrl && !key.meta && input !== ' ') setNavigating(false);
  });

  const shouldAppendChar = (ch: string) => ch !== ' ' || !navigating;

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

  return (
    <FilterableList
      title={`Planner Skills (${checked.size} selected)`}
      hint={hintText}
      items={sortedSkills}
      filterFn={filterSkill}
      getKey={(s) => s.id}
      renderItem={() => null}
      onConfirm={handleConfirm}
      onCancel={() => overlayStore.close()}
      shouldAppendChar={shouldAppendChar}
      bordered={false}
      chromeRows={12}
      maxVisible={5}
      placeholder={<Text color={t.textDim}>{'  No matching skills'}</Text>}
    >
      {({ filtered, cursor }) => {
        filteredRef.current = { filtered, cursor };
        const sectioned = toSectionedList(filtered, (s) => s.scope);
        return (
          <>
            {sectioned.map(({ item: skill, sectionHeader }, i) => (
              <Box key={skill.id} flexDirection="column">
                {sectionHeader && (
                  <Box marginTop={i > 0 ? 1 : 0}>
                    <Text bold color={t.text}>{'  '}{sectionHeader === 'project' ? 'Project' : 'Global'}</Text>
                  </Box>
                )}
                <SkillRow
                  skill={skill}
                  isCursor={i === cursor}
                  isChecked={checked.has(skill.id)}
                  nameColWidth={nameColWidth}
                  descMaxWidth={descMaxWidth}
                  theme={t}
                />
              </Box>
            ))}
          </>
        );
      }}
    </FilterableList>
  );
}
