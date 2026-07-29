import { useState } from 'react';
import { Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import { ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../components/separators.js';
import { skillsStore } from '../../stores/project/skills.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { useStores } from '../../stores/use-stores.js';
import { truncateTerminalDisplayText } from '../../utils/display-text.js';
import { FilterableList } from '../../components/pickers/filterable-list.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';

const filterSkill = (s: SkillMeta, query: string): boolean => {
  if (query.endsWith(' ')) {
    return filterByFields(s, query, ['name']);
  }
  return filterByFields(s, query, ['name', 'description']);
};

const SECTION_LABELS = {
  project: 'Project',
  global: 'Global',
} as const;

interface SkillRowProps {
  skill: SkillMeta;
  isCursor: boolean;
  isChecked: boolean;
  nameColWidth: number;
  descMaxWidth: number;
  width: number;
  showDesc: boolean;
}

function SkillRow({
  skill,
  isCursor,
  isChecked,
  nameColWidth,
  descMaxWidth,
  width,
  showDesc,
}: SkillRowProps) {
  const name = truncateTerminalDisplayText(skill.name, nameColWidth);
  const desc = truncateTerminalDisplayText(skill.description, descMaxWidth);
  return (
    <ListRow
      state={isCursor ? 'active' : 'default'}
      label={name}
      labelWidth={nameColWidth}
      width={width}
      selected={isChecked}
      {...(showDesc && desc ? { metadata: desc } : {})}
    />
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
    ...skills.filter((s) => s.scope === 'project'),
    ...skills.filter((s) => s.scope === 'global'),
  ];

  const toggle = (id: string) => {
    setChecked((prev) => {
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

  const hintText = navigating
    ? `space toggle${SOFT_SEP}ctrl+a all${SOFT_SEP}⏎ confirm${SOFT_SEP}esc close`
    : `↑↓ navigate${SOFT_SEP}ctrl+a all${SOFT_SEP}⏎ confirm${SOFT_SEP}esc close`;

  const panelWidth = getResponsivePanelWidth({ cols, size: isSmall ? 'small' : 'large' });
  const nameColWidth = Math.max(8, Math.min(isSmall ? 20 : 26, Math.max(1, panelWidth - 10)));
  const descMaxWidth = Math.max(1, panelWidth - 8 - nameColWidth);

  return (
    <FilterableList
      items={sortedSkills}
      filterFn={filterSkill}
      getKey={(skill) => skill.id}
      onConfirm={handleConfirm}
      onActivate={(skill) => toggle(skill.id)}
      title={`Skills${SOFT_SEP}${checked.size} selected`}
      hint={hintText}
      chromeRows={12}
      width={panelWidth}
      customKeys={(
        input,
        key,
        { filtered: current, selectedIndex: currentIndex, appendToFilter },
      ) => {
        if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
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
        if (input === ' ') {
          if (navigating) {
            const item = current[currentIndex];
            if (item) toggle(item.id);
          } else {
            appendToFilter(' ');
          }
          return true;
        }
        if (input && !key.ctrl && !key.meta && input !== ' ') {
          setNavigating(false);
        }
        return false;
      }}
      placeholder={
        skills.length === 0 ? (
          <Text color={t.textDim}>
            No skills yet — add them under .claude/skills/ or {SPLITBRIEF_DIR}/skills/
          </Text>
        ) : (
          <Text color={t.textDim}>No matching skills</Text>
        )
      }
      section={{
        by: (skill) => skill.scope,
        gapBetweenSections: true,
        renderHeader: (section) => (
          <Text color={t.textDim}>
            {section === 'project' ? SECTION_LABELS.project : SECTION_LABELS.global}
          </Text>
        ),
      }}
      renderItem={(skill, { isCursor }) => (
        <SkillRow
          skill={skill}
          isCursor={isCursor}
          isChecked={checked.has(skill.id)}
          nameColWidth={nameColWidth}
          descMaxWidth={descMaxWidth}
          width={panelWidth}
          showDesc={!isSmall}
        />
      )}
    />
  );
}
