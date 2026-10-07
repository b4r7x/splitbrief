import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useEffect, useState } from 'react';
import { basename, dirname } from 'node:path';
import { Box } from 'ink';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { configStore } from '../../stores/project/config.js';
import { externalEditRequestStore } from '../../stores/ui/external-edit-request.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { planSaveErrors } from '../../features/editor/plan-save.js';
import { SOFT_SEP } from '../../core/separators.js';
import { useEditorKeys } from '../../features/editor/use-editor-keys.js';
import { EditorBufferView } from '../../features/editor/editor-buffer-view.js';
import { FramePanel, OVERLAY_FRAME_COLS } from '../../features/workflow/components/frame-panel.js';

const FRAME_ROWS = 5; // border 2 + title 1 + divider 1 + footer 1

function saveRefusal(errors: readonly string[]): string {
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  return `Not saved: ${errors[0]}${more}`;
}

export function EditorOverlay() {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const filePath = editorStore.use((s) => (s.status === 'open' ? s.filePath : null));
  const projectDir = configStore.use((s) => s.projectDir);
  const [refusal, setRefusal] = useState<string | null>(null);

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

  const onSave = () => {
    const state = editorStore.get();
    if (
      state.status !== 'open' ||
      state.filePath === null ||
      reviewStore.get().ownerToken !== state.ownerToken
    ) {
      overlayStore.close();
      return;
    }
    const errors = planSaveErrors(state.value, projectDir);
    if (errors.length > 0) {
      setRefusal(saveRefusal(errors));
      return;
    }
    const fileName = basename(state.filePath);
    const sessionId = basename(dirname(state.filePath));
    writeSpecFile({ projectDir, sessionId }, fileName, state.value, null);
    overlayStore.close();
    // plan.md is rendered from plan.json: the engine checks the context fit and compiles it.
    editorStore.close();
    feedbackStore.setMessage(`Saved ${fileName} — applying changes`);
    externalEditRequestStore.requestApply(state.ownerToken);
  };

  const onCancel = () => {
    overlayStore.close();
  };

  const onOpenExternal = () => {
    const state = editorStore.get();
    if (state.status !== 'open') return;
    const token = state.ownerToken;
    if (state.filePath !== null && reviewStore.get().ownerToken === token) {
      const sessionId = basename(dirname(state.filePath));
      writeSpecFile({ projectDir, sessionId }, basename(state.filePath), state.value, null);
    }
    overlayStore.close();
    editorStore.close();
    externalEditRequestStore.request(token, state.opened);
  };

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
          {`ctrl+s save${SOFT_SEP}ctrl+o external${SOFT_SEP}esc cancel`}
        </Text>
      </Box>
    </FramePanel>
  );
}
