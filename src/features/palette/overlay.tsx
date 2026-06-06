import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { windowSlice } from '../../components/pickers/scroll-window.js';
import { buildPaletteResults } from './results.js';
import type { PaletteResult } from './results.js';
import { buildPaletteSources } from './sources.js';
import { commandPaletteMruStore } from '../../stores/ui/command-palette-mru.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const MAX_VISIBLE = 8;

export interface CommandPaletteOverlayProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (raw: string) => unknown;
  onWorkflowMode: (mode: WorkflowMode) => unknown;
}

export function CommandPaletteOverlay({
  commands,
  onRuntimeCommand,
  onWorkflowMode,
}: CommandPaletteOverlayProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const screen = routerStore.use((s) => s.screen);
  const config = configStore.useConfig();
  const phase = lifecycleStore.use((s) => s.phase);
  const mruIds = commandPaletteMruStore.use((s) => s.ids);
  const tasks = tasksStore.use((s) => s.tasks);
  const sessions = sessionsStore.use((s) => s.sessions);
  const projectDir = configStore.use((s) => s.projectDir);

  useEffect(() => {
    sessionsStore.load(projectDir);
  }, [projectDir]);

  const sources = buildPaletteSources({
    commands,
    screen,
    config,
    phase,
    tasks,
    sessions,
    onRuntimeCommand,
    onWorkflowMode,
  });

  const results = buildPaletteResults({
    query,
    mruIds,
    ...sources,
  });

  useInput(
    (input, key) => {
      if (key.escape) {
        overlayStore.close();
        return;
      }
      if (key.return) {
        const item = results[cursor];
        if (item) {
          commandPaletteMruStore.record(item.id);
          overlayStore.close();
          try {
            item.action();
          } catch (err) {
            feedbackStore.setError(toErrorMessage(err));
          }
        }
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(results.length - 1, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setCursor(0);
      }
    },
    { isActive: true },
  );

  const t = useTheme();

  const { scrollOffset, visibleSlice: visible } = windowSlice(results, cursor, MAX_VISIBLE);

  return (
    <OverlayPanel title="Command Palette" hint={'↑↓ navigate  Enter select  Esc close'}>
      <Box marginBottom={1}>
        <Text color={t.textDim}>{'❯ '}</Text>
        <Text>{query}</Text>
        <Text color={t.accent}>{'_'}</Text>
      </Box>

      <Box flexDirection="column">
        {visible.length === 0 && query.length > 0 && (
          <Text color={t.textDim}> No matching commands</Text>
        )}
        {visible.map((result, i) => {
          const globalIndex = scrollOffset + i;
          const isCursor = globalIndex === cursor;
          return <ResultRow key={result.id} result={result} isCursor={isCursor} />;
        })}
      </Box>
    </OverlayPanel>
  );
}

function ResultRow({ result, isCursor }: { result: PaletteResult; isCursor: boolean }) {
  const t = useTheme();
  return (
    <Box>
      <Text color={isCursor ? t.accent : t.text}>{isCursor ? '▸ ' : '  '}</Text>
      <Text color={t.textDim}>{`[${result.source}]`}</Text>
      <Text> </Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>
        {result.label}
      </Text>
      {result.description ? (
        <>
          <Text> </Text>
          <Text color={t.textDim}>{result.description}</Text>
        </>
      ) : null}
      {result.shortcut ? (
        <>
          <Text> </Text>
          <Text color={t.textDim}>{`[${result.shortcut}]`}</Text>
        </>
      ) : null}
    </Box>
  );
}
