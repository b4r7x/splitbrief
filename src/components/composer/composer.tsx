import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from '../input/multiline-input.js';
import { CommandCompletionMenu } from './completion/command/menu.js';
import { ReferenceCompletionMenu } from './completion/reference/menu.js';
import { AttachmentChips } from './attachments.js';
import { useCommandCompletion } from './completion/command/hook.js';
import { useReferenceCompletion } from './completion/reference/hook.js';
import { useTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { completionStore } from '../../stores/ui/completion.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { projectFilesStore } from '../../stores/ui/project-files.js';
import { configStore } from '../../stores/project/config.js';
import { listProjectFiles } from '../../lib/file-listing.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../../core/paths.js';
import { useStores } from '../../stores/use-stores.js';
import type { Screen } from '../../core/navigation/types.js';
import type { InputMode } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useHistory } from './use-history.js';
import { attachImage } from '../../stores/workflow/attachments.js';
import { computeCompletionOverlayRows, computeCompletionCap } from './completion/layout.js';

const MAX_REFERENCE_SUGGESTIONS = 8;

function borderColorForMode(
  mode: InputMode,
  theme: { planner: string; warning: string; border: string },
): string {
  if (mode === 'review') return theme.planner;
  if (mode === 'question') return theme.warning;
  return theme.border;
}

function placeholderForMode(mode: InputMode, hint?: string): string {
  if (hint) return hint;
  if (mode === 'review') return 'approve / edit / comment ... / quit';
  if (mode === 'question') return 'type your answer...';
  return 'describe your feature...';
}

const SESSIONS_REL_DIR = `${DIPTYCH_DIR}/${SESSIONS_DIR}`;
const SESSIONS_EXCLUDE = new RegExp(`(?:^|/)${SESSIONS_REL_DIR.replace(/[.]/g, '\\$&')}/`);

async function readProjectFiles(projectDir: string): Promise<string[]> {
  if (!projectDir) return [];
  try {
    return await listProjectFiles(projectDir, {
      excludePatterns: [SESSIONS_EXCLUDE],
      skipRelativeDirs: [SESSIONS_REL_DIR],
    });
  } catch {
    return [];
  }
}

interface ComposerProps {
  onSubmit: (text: string) => void;
  onRuntimeCommand: (command: string) => void;
  commands: RuntimeCommandDef[];
  mode: InputMode;
  hint: string;
  currentScreen: Screen;
  width?: number;
  disabled?: boolean;
  homeHint?: string | undefined;
  onEmptySubmit?: (() => void) | undefined;
}

export function Composer({
  onSubmit,
  onRuntimeCommand,
  commands,
  mode,
  hint,
  currentScreen,
  width,
  disabled,
  homeHint,
  onEmptySubmit,
}: ComposerProps) {
  const theme = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const [{ projectDir }] = useStores(configStore);
  const inputColumns = Math.max(1, (width ?? cols) - 6);
  const [value, setValue] = useState('');
  const [visibleRows, setVisibleRows] = useState(1);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);

  const refreshEpoch = projectFilesStore.use((s) => s.refreshEpoch);

  const { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, onChange } = useHistory({
    currentScreen,
    disabled,
    value,
    setValue,
  });

  const command = useCommandCompletion({
    commands,
    currentScreen,
    value,
    setValue: onChange,
    onRuntimeCommand,
    disabled,
  });

  const reference = useReferenceCompletion({
    files: projectFiles,
    value,
    setValue: onChange,
    disabled,
  });

  const showCommandSuggestions = command.showSuggestions;
  const showReferenceSuggestions = reference.showSuggestions && !showCommandSuggestions;

  const handleFileDrop = (path: string) => {
    const result = attachImage(path, projectDir);
    if (result.ok) {
      feedbackStore.setMessage(`Attached: ${result.path}`);
    } else {
      feedbackStore.setError(`Cannot attach: ${result.reason}`);
    }
  };

  const handleSubmit = (text: string) => {
    if (showCommandSuggestions || showReferenceSuggestions) return;
    const trimmed = text.trim();
    if (!trimmed) {
      onEmptySubmit?.();
      return;
    }

    if (currentScreen === 'home') {
      inputHistoryStore.push(trimmed);
    }

    if (trimmed.startsWith('/')) {
      onRuntimeCommand(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setValue('');
    resetHistory();
    bumpEpoch();
  };

  const handleInputBoundaryNavigate = (direction: 'up' | 'down') => {
    if (showCommandSuggestions || showReferenceSuggestions) return true;
    return handleBoundaryNavigate(direction);
  };

  const completionCap = computeCompletionCap(rows, visibleRows);
  const referenceSuggestionsCap = Math.min(MAX_REFERENCE_SUGGESTIONS, completionCap);
  const commandOverlayRows = showCommandSuggestions
    ? computeCompletionOverlayRows({
        itemCount: command.filtered.length,
        selectedIndex: command.selectedIndex,
        maxVisible: completionCap,
        hasFuzzyMatch: command.fuzzyMatch !== null,
      })
    : 0;
  const referenceOverlayRows = showReferenceSuggestions
    ? computeCompletionOverlayRows({
        itemCount: reference.filtered.length,
        selectedIndex: reference.selectedIndex,
        maxVisible: referenceSuggestionsCap,
      })
    : 0;
  const reserveHomeHint = currentScreen === 'home';
  const showHomeHint =
    reserveHomeHint &&
    homeHint !== undefined &&
    !showCommandSuggestions &&
    !showReferenceSuggestions;

  useEffect(() => {
    let active = true;
    void readProjectFiles(projectDir).then((files) => {
      if (active) setProjectFiles(files);
    });
    return () => {
      active = false;
    };
  }, [projectDir, refreshEpoch]);

  useEffect(() => {
    inputHeightStore.setRows(visibleRows + 2);
  }, [visibleRows]);

  const completionOpen = showCommandSuggestions || showReferenceSuggestions;
  useEffect(() => {
    completionStore.setOpen(completionOpen);
    return () => completionStore.setOpen(false);
  }, [completionOpen]);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0} overflow="visible">
      {reserveHomeHint && (
        <Box justifyContent="center" height={1}>
          {showHomeHint ? <Text color={theme.textDim}>{homeHint}</Text> : <Text> </Text>}
        </Box>
      )}
      <AttachmentChips />
      <Box flexDirection="column" width="100%" overflow="visible">
        <Box
          borderStyle="round"
          borderColor={borderColorForMode(mode, theme)}
          paddingX={1}
          width="100%"
          minHeight={3}
          flexShrink={0}
        >
          <Text color={theme.accent}>&gt; </Text>
          <Box flexGrow={1} overflow="hidden">
            <MultilineInput
              key={`${command.inputKey}:${reference.inputKey}:${inputEpoch}`}
              value={value}
              onChange={onChange}
              onSubmit={handleSubmit}
              onFileDrop={handleFileDrop}
              columns={inputColumns}
              focus={!disabled}
              placeholder={placeholderForMode(mode, hint)}
              rows={1}
              maxRows={6}
              onVisibleRowsChange={setVisibleRows}
              keyBindings={{
                submit: (key: { return: boolean; shift: boolean }) => key.return && !key.shift,
                newline: (key: { return: boolean; shift: boolean }) => key.return && key.shift,
              }}
              onBoundaryNavigate={handleInputBoundaryNavigate}
            />
          </Box>
        </Box>
        {showCommandSuggestions && (
          <Box position="absolute" width="100%" marginTop={-commandOverlayRows}>
            <CommandCompletionMenu
              filtered={command.filtered}
              selectedIndex={command.selectedIndex}
              fuzzyMatch={command.fuzzyMatch}
              maxVisible={completionCap}
            />
          </Box>
        )}
        {showReferenceSuggestions && (
          <Box position="absolute" width="100%" marginTop={-referenceOverlayRows}>
            <ReferenceCompletionMenu
              filtered={reference.filtered}
              selectedIndex={reference.selectedIndex}
              maxVisible={referenceSuggestionsCap}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
