import { Box, Text } from 'ink';
import { ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../components/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel, overlayInnerRowCapacity } from '../../components/overlays/overlay-panel.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from '../../components/pickers/row-zone.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { reportConfigSaveFailure } from '../../stores/project/save-feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-stores.js';
import { truncateTerminalDisplayText } from '../../utils/display-text.js';
import { useStaticSelector } from '../../hooks/use-static-selector.js';
import { WORKFLOW_MODES, type WorkflowMode } from '../../core/schemas/enums.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';

interface ModeDef {
  mode: WorkflowMode;
  cost: string;
  phases: string;
}

const MODE_METADATA: Record<WorkflowMode, { cost: string; phases: string }> = {
  quick: { cost: `1 call${SOFT_SEP}0 gates`, phases: 'plan and go; no brief compiler' },
  standard: { cost: `4 calls${SOFT_SEP}1 gate`, phases: 'spec gate, brief review, compiler' },
  speckit: { cost: `6-7 calls${SOFT_SEP}2 gates`, phases: 'adds clarify + constitution phases' },
};

const PANEL_DENSITY: OverlayDensity = 'compact';
const MODE_SELECTOR_TITLE_ROWS = 2;
const MODE_SELECTOR_HINT_ROWS = 2;
const MODE_LABEL_WIDTH = 12;
const MODE_LEAD_WIDTH = 2;
const MODE_CHECK_WIDTH = 2;
const MODE_METADATA_PREFIX_WIDTH = 1;

function smallModeMetadata(mode: ModeDef, panelInnerWidth: number): string {
  const metadata = `${mode.cost}${SOFT_SEP}${mode.phases}`;
  const metadataWidth =
    panelInnerWidth -
    MODE_LEAD_WIDTH -
    MODE_LABEL_WIDTH -
    MODE_CHECK_WIDTH -
    MODE_METADATA_PREFIX_WIDTH;
  return truncateTerminalDisplayText(metadata, Math.max(0, metadataWidth));
}

function modeEntryRows(index: number, isSmall: boolean, total: number): number {
  if (isSmall) return 1;
  return 2 + (index < total - 1 ? 1 : 0);
}

function visibleModeIndices(rowBudget: number, isSmall: boolean): number[] {
  if (rowBudget <= 0) return [];
  const indices: number[] = [];
  let used = 0;
  for (let i = 0; i < MODES.length; i++) {
    const height = modeEntryRows(i, isSmall, MODES.length);
    if (used + height > rowBudget) break;
    used += height;
    indices.push(i);
  }
  return indices;
}

const MODES: readonly ModeDef[] = WORKFLOW_MODES.map((mode) => ({
  mode,
  ...MODE_METADATA[mode],
}));

export function ModeSelector() {
  const t = useTheme();
  const [{ cols, rows, isSmall }] = useStores(terminalSizeStore);
  const config = configStore.useConfig();
  const currentMode = getWorkflowMode(config);
  const currentIdx = MODES.findIndex((m) => m.mode === currentMode);
  const panelInnerWidth = overlayRect({ cols, rows, density: PANEL_DENSITY }).innerWidth;
  const modeRowBudget = overlayInnerRowCapacity({
    rows,
    outerChromeRows: MODE_SELECTOR_TITLE_ROWS + MODE_SELECTOR_HINT_ROWS,
  });
  const actionableModeIndices = new Set(visibleModeIndices(modeRowBudget, isSmall));
  const hasActionableModes = actionableModeIndices.size > 0;

  const selectMode = async (item: ModeDef, index: number) => {
    if (!actionableModeIndices.has(index)) return;
    const updated = { ...config, workflow: { ...config.workflow, mode: item.mode } };
    const result = await configStore.save(updated);
    if (reportConfigSaveFailure(result)) return;
    feedbackStore.setMessage(`Mode set to: ${item.mode}`);
    overlayStore.close();
  };

  const { selectedIndex } = useStaticSelector<ModeDef>({
    items: MODES,
    initialIndex: currentIdx,
    onSelect: (item, index) => {
      void selectMode(item, index);
    },
    onCancel: () => overlayStore.close(),
    isIndexActionable: (index) => actionableModeIndices.has(index),
  });

  const hint = hasActionableModes
    ? `↑↓ navigate${SOFT_SEP}⏎ confirm${SOFT_SEP}esc close`
    : `↑↓ navigate${SOFT_SEP}esc close`;

  return (
    <OverlayPanel hint={hint} density={PANEL_DENSITY}>
      <Box marginBottom={1}>
        <Text color={t.textDim}>Workflow mode</Text>
      </Box>

      {MODES.map((m, i) => {
        if (!actionableModeIndices.has(i)) return null;
        const isSelected = i === selectedIndex;
        const isCurrent = m.mode === currentMode;
        return (
          <RowZone
            key={m.mode}
            zoneId={`mode:${m.mode}`}
            z={ROW_ZONE_Z_OVERLAY}
            onActivate={() => {
              void selectMode(m, i);
            }}
          >
            <Box flexDirection="column" marginBottom={i < MODES.length - 1 && !isSmall ? 1 : 0}>
              <ListRow
                label={m.mode}
                state={isSelected ? 'active' : 'default'}
                labelWidth={MODE_LABEL_WIDTH}
                metadata={isSmall ? smallModeMetadata(m, panelInnerWidth) : m.cost}
                width={panelInnerWidth}
                selected={isSmall ? isCurrent : undefined}
                trailing={!isSmall && isCurrent ? `${glyph('check')} Current` : undefined}
                trailingColor={t.success}
              />
              {!isSmall && (
                <Box marginLeft={14}>
                  <Text color={t.textDim}>{m.phases}</Text>
                </Box>
              )}
            </Box>
          </RowZone>
        );
      })}
    </OverlayPanel>
  );
}
