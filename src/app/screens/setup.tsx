import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { useTheme } from '../../components/theme.js';
import { glyph } from '../../lib/glyphs.js';
import { ListRow } from '../../components/list-row.js';
import { RowZone, ROW_ZONE_Z_SCREEN } from '../../components/pickers/row-zone.js';
import { SOFT_SEP } from '../../components/separators.js';
import {
  OverlayPanel,
  computeOverlayInnerRowCapacity,
} from '../../components/overlays/overlay-panel.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-stores.js';
import { copyToClipboard } from '../../lib/clipboard/clipboard.js';
import { formatCopyResult } from '../../core/runtime/commands/types.js';
import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import type { Config } from '../../core/schemas/config.js';

type Step = 'no-planners' | 'planner' | 'implementer';

const INSTALL_COMMANDS = ['npm i -g @anthropic-ai/claude-code', 'npm i -g @openai/codex'];

const SETUP_NO_PLANNER_TITLE_ROWS = 2;
const SETUP_NO_PLANNER_STATUS_ROWS = 1;
const SETUP_NO_PLANNER_GAP_ROWS = 1;
const SETUP_NO_PLANNER_GUIDANCE_ROWS = 2;
const SETUP_NO_PLANNER_FOOTER_ROWS = 3;

function setupNoPlannerChromeRows(): number {
  return (
    SETUP_NO_PLANNER_TITLE_ROWS +
    SETUP_NO_PLANNER_STATUS_ROWS +
    SETUP_NO_PLANNER_GAP_ROWS +
    SETUP_NO_PLANNER_GUIDANCE_ROWS +
    SETUP_NO_PLANNER_GAP_ROWS +
    SETUP_NO_PLANNER_GAP_ROWS +
    SETUP_NO_PLANNER_FOOTER_ROWS
  );
}

function visibleInstallCommandCount(terminalRows: number): number {
  const rowBudget = computeOverlayInnerRowCapacity({
    terminalRows,
    outerChromeRows: setupNoPlannerChromeRows(),
  });
  return Math.min(INSTALL_COMMANDS.length, Math.max(0, rowBudget));
}

export interface SetupToolPickerArgs {
  role: 'planner' | 'implementer';
  stepLabel: string;
  onConfirm: (updated: Config) => void;
  onCancel: () => void;
}

interface SetupScreenProps {
  renderToolPicker: (args: SetupToolPickerArgs) => ReactNode;
}

export function SetupScreen({ renderToolPicker }: SetupScreenProps) {
  const t = useTheme();
  const { exit } = useApp();
  const [{ planners }, { projectDir }, { cols, rows, isSmall }] = useStores(
    detectionStore,
    configStore,
    terminalSizeStore,
  );
  const onComplete = routerStore.use((s) => (s.screen === 'setup' ? s.onComplete : undefined));
  const pendingFeature = routerStore.use((s) => (s.screen === 'setup' ? s.feature : undefined));
  const pendingPlannerContext = routerStore.use((s) =>
    s.screen === 'setup' ? s.plannerContext : undefined,
  );
  const pendingAllowRepoRunners = routerStore.use((s) =>
    s.screen === 'setup' ? s.allowRepoRunners : undefined,
  );
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');

  const [step, setStep] = useState<Step>(() =>
    planners.filter((p) => p.available && p.type !== 'shell').length === 0
      ? 'no-planners'
      : 'planner',
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const visibleInstallCount =
    step === 'no-planners' ? visibleInstallCommandCount(rows) : INSTALL_COMMANDS.length;
  const clampedFocusIndex =
    visibleInstallCount > 0 ? Math.min(focusIndex, visibleInstallCount - 1) : 0;

  const copyCommand = (index: number) => {
    if (visibleInstallCount <= 0 || index >= visibleInstallCount) return;
    const command = INSTALL_COMMANDS[index];
    if (!command) return;
    void (async () => {
      try {
        const result = await copyToClipboard(command);
        if (result === 'unavailable') {
          feedbackStore.setError('Could not copy: no clipboard available over this connection');
        } else {
          feedbackStore.setMessage(formatCopyResult(result));
        }
      } catch {
        feedbackStore.setError('Could not copy to clipboard');
      }
    })();
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        exit();
        return;
      }
      if (key.upArrow) {
        if (visibleInstallCount <= 0) return;
        setFocusIndex((i) => Math.max(0, Math.min(i, visibleInstallCount - 1) - 1));
        return;
      }
      if (key.downArrow) {
        if (visibleInstallCount <= 0) return;
        setFocusIndex((i) => Math.min(visibleInstallCount - 1, i + 1));
        return;
      }
      if (input === 'y') {
        copyCommand(clampedFocusIndex);
      }
    },
    { isActive: step === 'no-planners' && !hasOverlay },
  );

  const finalize = (finalConfig: Config) => {
    if (!projectDir) return;
    const result = configStore.save(finalConfig);
    if (!result.ok) {
      if (result.error) feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      return;
    }
    if (onComplete === 'workflow' && pendingFeature) {
      routerStore.navigate({
        to: 'workflow',
        feature: pendingFeature,
        plannerContext: pendingPlannerContext,
        allowRepoRunners: pendingAllowRepoRunners,
      });
    } else {
      routerStore.navigate({ to: 'home' });
    }
  };

  if (step === 'no-planners') {
    const panelWidth = getResponsivePanelWidth({ cols, size: isSmall ? 'small' : 'large' });
    return (
      <OverlayPanel width={panelWidth} title={`Setup${SOFT_SEP}planner${SOFT_SEP}1 of 2`}>
        <Text color={t.textDim}>{`${glyph('statusPending')} No planner detected`}</Text>
        <Box height={1} />
        <Text color={t.textDim}>
          Diptych compiles task briefs with a planner. Install one, then re-run init:
        </Text>
        <Box height={1} />
        {INSTALL_COMMANDS.slice(0, visibleInstallCount).map((command, i) => {
          const active = i === clampedFocusIndex;
          return (
            <Box key={command} width="100%">
              <RowZone
                zoneId={`setup-install:${i}`}
                z={ROW_ZONE_Z_SCREEN}
                onActivate={() => setFocusIndex(i)}
              >
                <ListRow label={command} state={active ? 'active' : 'default'} />
              </RowZone>
              {active && visibleInstallCount > 0 ? (
                <RowZone
                  zoneId="setup-copy"
                  z={ROW_ZONE_Z_SCREEN}
                  onActivate={() => copyCommand(i)}
                >
                  <Text color={t.textDim}> y copy</Text>
                </RowZone>
              ) : null}
            </Box>
          );
        })}
        <Box height={1} />
        <Box width="100%" overflow="hidden">
          <Text color={t.border}>{glyph('divider').repeat(panelWidth)}</Text>
        </Box>
        <Text color={t.textDim}>
          {visibleInstallCount > 0 ? `↑↓ navigate${SOFT_SEP}y copy${SOFT_SEP}esc quit` : `esc quit`}
        </Text>
      </OverlayPanel>
    );
  }

  if (step === 'planner') {
    return renderToolPicker({
      role: 'planner',
      stepLabel: `Choose planner${SOFT_SEP}1 of 2`,
      onConfirm: (updated) => {
        const result = configStore.save(updated);
        if (result.ok) {
          setStep('implementer');
        } else if (result.error) {
          feedbackStore.setError(`Failed to save config: ${result.error.message}`);
        }
      },
      onCancel: exit,
    });
  }

  return renderToolPicker({
    role: 'implementer',
    stepLabel: `Choose model${SOFT_SEP}2 of 2`,
    onConfirm: finalize,
    onCancel: () => setStep('planner'),
  });
}
