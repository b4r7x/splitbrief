import { Box, useInput } from 'ink';
import { layoutPanelNotice, PanelNotice } from '../../components/notice.js';
import { OverlayPanel } from '../../components/overlays/panel.js';
import { useTheme, ThemeText as Text } from '../../components/theme.js';
import { BOOT_MANIFEST_TITLE, TOOL_CHECK_FAILED_TITLE } from '../../core/discovery/copy.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
import { SOFT_SEP } from '../../core/separators.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore, selectHasOverlay } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { BootManifest } from './boot-manifest.js';
import { ToolRollCall } from './tool-roll-call.js';

type ColdDiscoveryPanelProps = Readonly<{
  state: 'initializing' | 'failed';
  noConfig: boolean;
  onBack: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}>;

export function ColdDiscoveryPanel({
  state,
  noConfig,
  onBack,
  onRetry,
  onOpenSettings,
}: ColdDiscoveryPanelProps) {
  const t = useTheme();
  const hasOverlay = overlayStore.use(selectHasOverlay);
  const feedback = feedbackStore.use((snapshot) => snapshot);
  const { cols, rows } = terminalSizeStore.use((size) => size);
  const { innerWidth } = overlayRect({ cols, rows, density: 'compact' });
  // The notice takes the one row of the note it stands in for, so the panel keeps its height.
  const notice = layoutPanelNotice(feedback, { width: innerWidth, maxRows: 1 });
  const feedbackNotice = notice === null ? undefined : <PanelNotice notice={notice} />;

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (state !== 'failed') return;
      if (input === 'r' || input === 'R') {
        onRetry();
        return;
      }
      if (input === 's' || input === 'S') onOpenSettings();
    },
    { isActive: !hasOverlay },
  );

  if (state === 'initializing') {
    return (
      <OverlayPanel title={BOOT_MANIFEST_TITLE} density="compact" hint="esc quit">
        {noConfig ? (
          <ToolRollCall footer={feedbackNotice} />
        ) : (
          <BootManifest footer={feedbackNotice} />
        )}
      </OverlayPanel>
    );
  }

  return (
    <OverlayPanel
      title={TOOL_CHECK_FAILED_TITLE}
      density="compact"
      hint={`r retry${SOFT_SEP}esc quit${SOFT_SEP}s settings`}
    >
      <Text color={t.error}>Your tools could not be checked.</Text>
      <Box marginTop={1}>
        <Text color={t.textDim}>Retry the check or review runner settings.</Text>
      </Box>
      {feedbackNotice}
    </OverlayPanel>
  );
}
