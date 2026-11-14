import { Box, useInput } from 'ink';
import { layoutFeedbackNotice, FeedbackNotice } from '../../components/feedback-notice.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { useTheme, ThemeText as Text } from '../../components/theme.js';
import { BOOT_MANIFEST_TITLE, TOOL_CHECK_FAILED_TITLE } from '../../core/discovery/copy.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
import { SOFT_SEP } from '../../core/separators.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { BootManifest } from './boot-manifest.js';
import { ToolRollCall } from './tool-roll-call.js';

type DiscoveryPanelProps = Readonly<{
  state: 'initializing' | 'failed';
  noConfig: boolean;
  onBack: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}>;

export function DiscoveryPanel({
  state,
  noConfig,
  onBack,
  onRetry,
  onOpenSettings,
}: DiscoveryPanelProps) {
  const t = useTheme();
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
  const feedback = feedbackStore.use((snapshot) => snapshot);
  const { cols, rows } = terminalSizeStore.use((size) => size);
  const { innerWidth } = overlayRect({ cols, rows, density: 'compact' });
  const notice = layoutFeedbackNotice(feedback, innerWidth);
  const feedbackNotice =
    notice === null ? undefined : <FeedbackNotice notice={notice} width={innerWidth} />;

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
