import { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import { ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../core/separators.js';
import { skillsStore } from '../../stores/project/skills.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
import { useStores } from '../../stores/use-stores.js';
import { truncateTerminalDisplayText } from '../../utils/display-text.js';
import { FilterableList } from '../../components/pickers/filterable-list.js';
import {
  GLOBAL_SKILL_SCAN_PATHS,
  PROJECT_SKILL_SCAN_PATH_LABELS,
} from '../../core/skills/scan-paths.js';

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

// The roots sit side by side, headed by their scope, so the placeholder is as tall as the longer
// list rather than their sum: 17 roots stacked overran the panel at every viewport. Project rows
// carry their `./` anchor; the global rows cannot carry theirs — a `~/` prefix is a host-path shape
// the gallery frame contract rejects (testing/visual/contracts/path-policy.ts) — so their scope
// header states it instead.
const SCAN_GROUPS = [
  { label: SECTION_LABELS.project, paths: PROJECT_SKILL_SCAN_PATH_LABELS },
  { label: SECTION_LABELS.global, paths: GLOBAL_SKILL_SCAN_PATHS },
];

const SCAN_COL_GAP = 2;

// Rows the panel spends on the title, the filter and the hint plus the blank lines between them.
// Measured at the 60x18 floor, where the frame holds 8 placeholder rows; taller viewports have
// slack, so the same subtraction stays inside the frame there too.
const PLACEHOLDER_CHROME_ROWS = 6;

function ScanRoots() {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const budget =
    overlayRect({ cols, rows, density: OVERLAY_DENSITY }).innerRows - PLACEHOLDER_CHROME_ROWS;
  const longest = Math.max(...SCAN_GROUPS.map((group) => group.paths.length));
  // The lead line and the scope headers take two rows; the overflow count takes a third when the
  // roots do not all fit.
  const shown = longest <= budget - 2 ? longest : Math.max(0, budget - 3);
  const hidden = SCAN_GROUPS.reduce(
    (total, group) => total + Math.max(0, group.paths.length - shown),
    0,
  );

  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>No skills found. Scanned, in precedence order:</Text>
      <Box gap={SCAN_COL_GAP}>
        {SCAN_GROUPS.map((group) => (
          <Box key={group.label} flexDirection="column">
            <Text color={t.textDim}>{group.label}</Text>
            {group.paths.slice(0, shown).map((path) => (
              <Text key={path} color={t.textDim}>
                {path}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      {hidden > 0 ? (
        <Text color={t.textDim}>{`+${hidden} more${SOFT_SEP}resize to see all`}</Text>
      ) : null}
    </Box>
  );
}

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
  const [{ available: skills, selected: initial }] = useStores(skillsStore);
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
    : `↑↓ select${SOFT_SEP}ctrl+a all${SOFT_SEP}⏎ confirm${SOFT_SEP}esc close`;

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
      placeholder={
        skills.length === 0 ? <ScanRoots /> : <Text color={t.textDim}>No matching skills</Text>
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
      renderItem={(skill, { isCursor, innerWidth }) => {
        const nameColWidth = Math.max(8, Math.min(26, Math.floor(innerWidth / 4)));
        return (
          <SkillRow
            skill={skill}
            isCursor={isCursor}
            isChecked={checked.has(skill.id)}
            nameColWidth={nameColWidth}
            descMaxWidth={Math.max(1, innerWidth - 5 - nameColWidth)}
            width={innerWidth}
            showDesc={innerWidth >= 70}
          />
        );
      }}
    />
  );
}
