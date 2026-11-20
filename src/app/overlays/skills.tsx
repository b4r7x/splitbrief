import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useState } from 'react';
import { useInput } from 'ink';
import { OverlayPanel } from '../../components/overlays/panel.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import { glyph } from '../../lib/glyphs.js';
import { SOFT_SEP } from '../../core/separators.js';
import {
  CLOSE_HINT,
  CONFIRM_HINT,
  formatKeyHints,
  SELECT_HINT,
} from '../../components/key-legend.js';
import { skillsStore } from '../../stores/project/skills.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { useStores } from '../../stores/use-many.js';
import { FilterableList } from '../../components/pickers/filterable-list.js';
import { PROJECT_SKILL_SCAN_PATH_LABELS } from '../../core/skills/scan-paths.js';

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

const OVERLAY_DENSITY = 'roomy';

function EmptySkills() {
  const t = useTheme();
  useInput((_input, key) => {
    if (key.escape) overlayStore.close();
  });
  return (
    <OverlayPanel
      title="Skills for every seat"
      density={OVERLAY_DENSITY}
      hint={formatKeyHints([CLOSE_HINT])}
    >
      <Text
        color={t.textDim}
      >{`No skills found. Add a project skill in ${PROJECT_SKILL_SCAN_PATH_LABELS[0]}.`}</Text>
    </OverlayPanel>
  );
}

export function SkillsPicker() {
  const t = useTheme();
  const [{ available: skills, selected: initial }] = useStores(skillsStore);
  const [checked, setChecked] = useState<Set<string>>(new Set(initial));
  const [navigating, setNavigating] = useState(false);

  if (skills.length === 0) return <EmptySkills />;

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

  const hintText = formatKeyHints([
    navigating ? { key: 'space', verb: 'toggle' } : SELECT_HINT,
    { key: 'ctrl+a', verb: 'all' },
    CONFIRM_HINT,
    CLOSE_HINT,
  ]);

  return (
    <FilterableList
      items={sortedSkills}
      filterFn={filterSkill}
      getKey={(skill) => skill.id}
      onConfirm={handleConfirm}
      onActivate={(skill) => toggle(skill.id)}
      title={`Skills for every seat${SOFT_SEP}${checked.size} selected`}
      hint={hintText}
      chromeRows={12}
      density={OVERLAY_DENSITY}
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
        if (input && !key.ctrl && !key.meta) {
          setNavigating(false);
        }
        return false;
      }}
      placeholder={<Text color={t.textDim}>No matching skills</Text>}
      section={{
        by: (skill) => SECTION_LABELS[skill.scope],
        gapBetweenSections: true,
      }}
      rowModel={(skill) => ({
        name: skill.name,
        description: skill.description,
        trailing: checked.has(skill.id) ? glyph('check') : '',
        trailingParts: [{ text: glyph('check'), tone: 'success' }],
      })}
    />
  );
}
