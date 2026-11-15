import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useEffect } from 'react';
import { Box } from 'ink';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { CANCEL_HINT, formatKeyHints } from '../../components/key-legend.js';
import { useEditorKeys } from '../../features/editor/use-keys.js';
import { usePlanEditorSession } from '../../features/editor/use-session.js';
import { EditorBufferView } from '../../features/editor/buffer-view.js';
import { FramePanel, OVERLAY_FRAME_COLS } from '../../components/frame-panel.js';

const FRAME_ROWS = 5; // border 2 + title 1 + divider 1 + footer 1

export function EditorOverlay() {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const filePath = editorStore.use((s) => (s.status === 'open' ? s.filePath : null));
  const { refusal, onSave, onCancel, onOpenExternal } = usePlanEditorSession();

  const viewport = Math.max(1, rows - FRAME_ROWS - (refusal === null ? 0 : 1));

  useEffect(() => {
    overlayStore.setExclusive(true);
    return () => {
      overlayStore.setExclusive(false);
    };
  }, []);

  useEffect(() => {
    // Reserve the frame horizontally (border + padding = OVERLAY_FRAME_COLS) and keep the extra
    // last column for the end-of-row caret cell so a caret parked at a full wrapped row's seam
    // (display col == wrap width) is not clipped (EditorBufferView renders width = columns + 1).
    // (cols - OVERLAY_FRAME_COLS - 1) + 1 == cols - OVERLAY_FRAME_COLS == the frame inner width, so
    // the reducer wraps at exactly the painted inner box (reducer ≡ view, CON-F).
    editorStore.setLayout({ columns: Math.max(1, cols - OVERLAY_FRAME_COLS - 1), rows: viewport });
  }, [cols, viewport]);

  useEditorKeys({ onSave, onCancel, onOpenExternal });

  return (
    <FramePanel filePath={filePath ?? 'file'} width={cols} height={rows}>
      <Box height={viewport} overflow="hidden">
        <EditorBufferView />
      </Box>
      {refusal !== null && (
        <Box height={1}>
          <Text color={t.error} wrap="truncate">
            {refusal}
          </Text>
        </Box>
      )}
      <Box height={1}>
        <Text color={t.textDim} wrap="truncate">
          {formatKeyHints([
            { key: 'ctrl+s', verb: 'save' },
            { key: 'ctrl+o', verb: 'external' },
            CANCEL_HINT,
          ])}
        </Text>
      </Box>
    </FramePanel>
  );
}
