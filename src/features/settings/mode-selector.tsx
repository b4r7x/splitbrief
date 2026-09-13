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
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../utils/display-text.js';
import { useStaticSelector } from '../../hooks/use-static-selector.js';
import { WORKFLOW_MODES, type WorkflowMode } from '../../core/schemas/enums.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';
import { MODES } from '../../core/pipeline-spec/modes.js';

interface ModeDef {
  mode: WorkflowMode;
  cost: string;
  costShort: string;
  phases: string;
}

// The counts are the pipeline spec's own, so the picker can never disagree with what a run does.
const MODE_PHASES: Record<WorkflowMode, string> = {
  quick: 'plan and go',
  standard: 'spec gate, brief review',
  speckit: 'adds clarify + constitution phases',
};

function modeCostText(mode: WorkflowMode, withGateNames: boolean): string {
  const { plannerCalls, gates } = MODES[mode];
  const calls = `${plannerCalls} planning ${plannerCalls === 1 ? 'call' : 'calls'}`;
  const counts = `${gates.length} gates`;
  const gateText = withGateNames && gates.length > 0 ? `${counts} (${gates.join(' + ')})` : counts;
  return `${calls}${SOFT_SEP}${gateText}`;
}

const PANEL_DENSITY: OverlayDensity = 'compact';
const MODE_SELECTOR_TITLE_ROWS = 2;
const MODE_SELECTOR_HINT_ROWS = 2;
const MODE_LABEL_WIDTH = 12;
const MODE_LEAD_WIDTH = 2;
const MODE_CHECK_WIDTH = 2;
const MODE_METADATA_PREFIX_WIDTH = 1;
/** Where `ListRow` starts the metadata text, so the counts line under it shares that column. */
const MODE_METADATA_COLUMN = MODE_LEAD_WIDTH + MODE_LABEL_WIDTH + MODE_METADATA_PREFIX_WIDTH;

function currentLabel(): string {
  return `${glyph('check')} Current`;
}

// The current-row marker keeps its column on every row, so a longer count never pushes it off the
// one row that carries it.
function modeMetadataText(mode: ModeDef, panelInnerWidth: number, isSmall: boolean): string {
  // Wide enough for two lines, the row names what the mode does and the line under it carries the
  // counts; a single row has to choose, and the counts are what a reader compares — whole, since a
  // cut inside the gate names leaves an unclosed parenthesis.
  const metadata = isSmall ? mode.costShort : mode.phases;
  // One column past the check, so a cut that does happen never reads into the marker.
  const reserved = isSmall ? MODE_CHECK_WIDTH + 1 : getTerminalCellWidth(currentLabel()) + 1;
  const metadataWidth =
    panelInnerWidth - MODE_LEAD_WIDTH - MODE_LABEL_WIDTH - reserved - MODE_METADATA_PREFIX_WIDTH;
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
  for (let i = 0; i < MODE_DEFS.length; i++) {
    const height = modeEntryRows(i, isSmall, MODE_DEFS.length);
    if (used + height > rowBudget) break;
    used += height;
    indices.push(i);
  }
  return indices;
}

const MODE_DEFS: readonly ModeDef[] = WORKFLOW_MODES.map((mode) => ({
  mode,
  cost: modeCostText(mode, true),
  costShort: modeCostText(mode, false),
  phases: MODE_PHASES[mode],
}));

export function ModeSelector() {
  const t = useTheme();
  const [{ cols, rows, isSmall }] = useStores(terminalSizeStore);
  const config = configStore.useConfig();
  const currentMode = getWorkflowMode(config);
  const currentIdx = MODE_DEFS.findIndex((m) => m.mode === currentMode);
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
    items: MODE_DEFS,
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

      {MODE_DEFS.map((m, i) => {
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
            <Box flexDirection="column" marginBottom={i < MODE_DEFS.length - 1 && !isSmall ? 1 : 0}>
              <ListRow
                label={m.mode}
                state={isSelected ? 'active' : 'default'}
                labelWidth={MODE_LABEL_WIDTH}
                metadata={modeMetadataText(m, panelInnerWidth, isSmall)}
                width={panelInnerWidth}
                selected={isSmall ? isCurrent : undefined}
                trailing={!isSmall && isCurrent ? currentLabel() : undefined}
                trailingColor={t.success}
              />
              {!isSmall && (
                <Box marginLeft={MODE_METADATA_COLUMN}>
                  <Text color={t.textDim}>{m.cost}</Text>
                </Box>
              )}
            </Box>
          </RowZone>
        );
      })}
    </OverlayPanel>
  );
}
