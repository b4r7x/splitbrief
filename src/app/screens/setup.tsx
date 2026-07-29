import { Fragment, useState } from 'react';
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
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';

type Step = 'no-planners' | 'planner' | 'implementer';

const INSTALL_ACTIONS = [
  { id: 'claude-code', command: 'npm i -g @anthropic-ai/claude-code' },
  { id: 'codex', command: 'npm i -g @openai/codex' },
] as const;

type InstallActionId = (typeof INSTALL_ACTIONS)[number]['id'];

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
  return Math.min(INSTALL_ACTIONS.length, Math.max(0, rowBudget));
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
  const [focusedInstallId, setFocusedInstallId] = useState<InstallActionId>('claude-code');
  const visibleInstallCount =
    step === 'no-planners' ? visibleInstallCommandCount(rows) : INSTALL_ACTIONS.length;
  const visibleInstallActions = INSTALL_ACTIONS.slice(0, visibleInstallCount);
  const focusedInstallIndex = visibleInstallActions.findIndex(
    (action) => action.id === focusedInstallId,
  );
  const clampedFocusIndex = focusedInstallIndex >= 0 ? focusedInstallIndex : 0;
  const focusedInstallAction = visibleInstallActions[clampedFocusIndex];

  const copyCommand = (id: InstallActionId) => {
    const action = visibleInstallActions.find((candidate) => candidate.id === id);
    if (!action) return;
    void (async () => {
      try {
        const result = await copyToClipboard(action.command);
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
        const action = visibleInstallActions[Math.max(0, clampedFocusIndex - 1)];
        if (action) setFocusedInstallId(action.id);
        return;
      }
      if (key.downArrow) {
        const action =
          visibleInstallActions[Math.min(visibleInstallCount - 1, clampedFocusIndex + 1)];
        if (action) setFocusedInstallId(action.id);
        return;
      }
      if (input === 'y' && focusedInstallAction) copyCommand(focusedInstallAction.id);
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
          {`${SPLITBRIEF_IDENTITY.displayName} compiles task briefs with a planner. Install one, then re-run init:`}
        </Text>
        <Box height={1} />
        {visibleInstallActions.map((action, i) => {
          const active = i === clampedFocusIndex;
          return (
            <Box key={action.id} width="100%">
              <RowZone
                zoneId={`setup-install:${action.id}`}
                z={ROW_ZONE_Z_SCREEN}
                onActivate={() => setFocusedInstallId(action.id)}
              >
                <ListRow label={action.command} state={active ? 'active' : 'default'} />
              </RowZone>
              {active ? (
                <RowZone
                  zoneId="setup-copy"
                  z={ROW_ZONE_Z_SCREEN}
                  onActivate={() => copyCommand(action.id)}
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
    return (
      <Fragment key="planner">
        {renderToolPicker({
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
        })}
      </Fragment>
    );
  }

  return (
    <Fragment key="implementer">
      {renderToolPicker({
        role: 'implementer',
        stepLabel: `Choose model${SOFT_SEP}2 of 2`,
        onConfirm: finalize,
        onCancel: () => setStep('planner'),
      })}
    </Fragment>
  );
}
