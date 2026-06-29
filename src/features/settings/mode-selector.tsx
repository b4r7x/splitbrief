import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { useTheme } from '../../components/theme.js';
import {
  OverlayPanel,
  computeOverlayInnerWidth,
  computeOverlayInnerRowCapacity,
} from '../../components/overlays/overlay-panel.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from '../../components/pickers/row-zone.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-stores.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';
import { useStaticSelector } from '../../hooks/use-static-selector.js';
import { WORKFLOW_MODES, type WorkflowMode } from '../../core/schemas/enums.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';

interface ModeDef {
  mode: WorkflowMode;
  cost: string;
  size: string;
}

const MODE_METADATA: Record<WorkflowMode, { cost: string; size: string }> = {
  instant: { cost: `1 call${SOFT_SEP}no approval`, size: 'trivial edits' },
  quick: { cost: `1 call${SOFT_SEP}no approval`, size: 'small fixes' },
  standard: { cost: `4 calls${SOFT_SEP}1 approval`, size: 'features' },
  speckit: { cost: `6-7 calls${SOFT_SEP}2 approvals`, size: 'large scope' },
};

const MODE_SELECTOR_TITLE_ROWS = 2;
const MODE_SELECTOR_HINT_ROWS = 2;

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
  const panelOuterWidth = getClampedTerminalWidth({ cols, maxWidth: isSmall ? 55 : 68 });
  const panelInnerWidth = computeOverlayInnerWidth(panelOuterWidth);
  const modeRowBudget = computeOverlayInnerRowCapacity({
    terminalRows: rows,
    outerChromeRows: MODE_SELECTOR_TITLE_ROWS + MODE_SELECTOR_HINT_ROWS,
  });
  const actionableModeIndices = new Set(visibleModeIndices(modeRowBudget, isSmall));
  const hasActionableModes = actionableModeIndices.size > 0;

  const selectMode = (item: ModeDef, index: number) => {
    if (!actionableModeIndices.has(index)) return;
    const updated = { ...config, workflow: { ...config.workflow, mode: item.mode } };
    const result = configStore.save(updated, { changedPaths: ['workflow.mode'] });
    if (result.ok) {
      feedbackStore.setMessage(`Mode set to: ${item.mode}`);
      overlayStore.close();
    } else if (result.error) {
      feedbackStore.setError(`Failed to save config: ${result.error.message}`);
    }
  };

  const { selectedIndex } = useStaticSelector<ModeDef>({
    items: MODES,
    initialIndex: currentIdx,
    onSelect: (item, index) => selectMode(item, index),
    onCancel: () => overlayStore.close(),
    isIndexActionable: (index) => actionableModeIndices.has(index),
  });

  const hint = hasActionableModes
    ? '↑↓ select  enter confirm  esc close'
    : '↑↓ navigate  esc close';

  return (
    <OverlayPanel hint={hint} maxWidth={panelOuterWidth}>
      <Box marginBottom={1}>
        <Text color={t.textDim}>workflow mode</Text>
      </Box>

      {MODES.map((m, i) => {
        if (!actionableModeIndices.has(i)) return null;
        const isSelected = i === selectedIndex;
        const isCurrent = m.mode === currentMode;
        const labelColor = isSelected ? t.accent : t.textDim;
        return (
          <RowZone
            key={m.mode}
            zoneId={`mode:${m.mode}`}
            z={ROW_ZONE_Z_OVERLAY}
            onActivate={() => selectMode(m, i)}
          >
            <Box flexDirection="column" marginBottom={i < MODES.length - 1 && !isSmall ? 1 : 0}>
              <Box width={panelInnerWidth}>
                <Text color={isSelected ? t.accent : t.textDim}>
                  {isSelected ? `${glyph('liveBar')} ` : '  '}
                </Text>
                <Box width={12}>
                  <Text color={labelColor} bold={isSelected}>
                    {m.mode}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={t.textDim}>
                    {isSmall ? `${m.cost}${SOFT_SEP}${m.size}` : m.cost}
                  </Text>
                </Box>
                {isCurrent && (
                  <Text color={t.success}>
                    {isSmall ? glyph('check') : `${glyph('check')} current`}
                  </Text>
                )}
              </Box>
              {!isSmall && (
                <Box marginLeft={4}>
                  <Text color={t.textDim}>{m.size}</Text>
                </Box>
              )}
            </Box>
          </RowZone>
        );
      })}
    </OverlayPanel>
  );
}
