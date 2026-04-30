import { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../components/theme.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getResponsivePanelWidth } from '../../core/layout/terminal-width.js';
import { filterByFields } from '../../components/pickers/picker-utils.js';
import { CursorCell } from '../../components/pickers/cursor-cell.js';
import { skillsStore } from '../../stores/project/skills.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { useStores } from '../../stores/use-stores.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';
import { FilterableList } from '../../components/pickers/filterable-list.js';

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
  const name = truncateWithEllipsis(skill.name, nameColWidth).padEnd(nameColWidth);
  const desc = truncateWithEllipsis(skill.description, descMaxWidth);
  return (
    <Box>
      <CursorCell isCursor={isCursor} />
      <Text color={isChecked ? t.success : t.textDim}>{isChecked ? '[x] ' : '[ ] '}</Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
      <Text color={t.textDim}>{'  '}{desc}</Text>
    </Box>
  );
}

export function SkillsPicker() {
  const t = useTheme();
  const [{ cols, isSmall }, { available: skills, selected: initial }] = useStores(
    terminalSizeStore,
    skillsStore,
  );
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

  const hintText = navigating
    ? 'Space toggle  Ctrl+A all  Enter confirm  Esc cancel'
    : '\u2191\u2193 to navigate  Ctrl+A all  Enter confirm  Esc cancel';

  const panelWidth = getResponsivePanelWidth(cols, isSmall);
  const nameColWidth = Math.max(8, Math.min(isSmall ? 20 : 26, Math.max(1, panelWidth - 10)));
  const descMaxWidth = Math.max(1, panelWidth - 8 - nameColWidth);

  return (
    <FilterableList
      items={sortedSkills}
      filterFn={filterSkill}
      getKey={(skill) => skill.id}
      onConfirm={handleConfirm}
      title={`Planner Skills (${checked.size} selected)`}
      hint={hintText}
      bordered={false}
      chromeRows={12}
      maxVisible={5}
      width={panelWidth}
      shouldAppendChar={shouldAppendChar}
      customKeys={(input, key, { filtered: current, selectedIndex: currentIndex }) => {
        if (key.upArrow || key.downArrow) {
          setNavigating(true);
          return false;
        }
        if (key.backspace || key.delete) {
          setNavigating(false);
          return false;
        }
        if (key.ctrl && input === 'a') {
          const ids = current.map((skill) => skill.id);
          setChecked((prev) => {
            const allChecked = ids.length > 0 && ids.every((id) => prev.has(id));
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
      }}
      placeholder={skills.length === 0 ? (
        <Box flexDirection="column">
          <Text color={t.textDim}>  No skills found.</Text>
          <Text color={t.textDim}>  Add skills to .claude/skills/ or .diptych/skills/ to get started.</Text>
        </Box>
      ) : (
        <Text color={t.textDim}>{'  No matching skills'}</Text>
      )}
      sectionBy={(skill) => skill.scope}
      renderSectionHeader={(section, index) => (
        <Box marginTop={index > 0 ? 1 : 0}>
          <Text bold color={t.text}>{'  '}{section === 'project' ? 'Project' : 'Global'}</Text>
        </Box>
      )}
      renderItem={(skill, { isCursor }) => (
        <SkillRow
          skill={skill}
          isCursor={isCursor}
          isChecked={checked.has(skill.id)}
          nameColWidth={nameColWidth}
          descMaxWidth={descMaxWidth}
          theme={t}
        />
      )}
    />
  );
}
