import { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { OverlayPanel } from '../../../components/overlays/overlay-panel.js';
import { buildPaletteResults } from '../../../engine/palette/aggregate.js';
import type { PaletteResult } from '../../../engine/palette/aggregate.js';
import { paletteMruStore } from '../../../stores/ui/palette-mru.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { createCommands } from '../../../core/slash-commands/catalog.js';
import { buildCommandContext } from '../../../app/slash-command-context.js';
import { toPaletteItems, executeSlashCommand } from '../../../core/slash-commands/dispatch.js';
import { WORKFLOW_MODES } from '../../../core/schemas/enums.js';

const MAX_VISIBLE = 8;

export function CommandPaletteOverlay() {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const screen = routerStore.use(s => s.screen);
  const config = configStore.useConfig();
  const phase = lifecycleStore.use(s => s.phase);
  const mruIds = paletteMruStore.use(s => s.ids);
  const tasks = tasksStore.use(s => s.tasks);
  const sessions = sessionsStore.use(s => s.sessions);
  const projectDir = configStore.use(s => s.projectDir);

  const { exit } = useApp();
  const ctx = buildCommandContext({ exit });
  const commands = createCommands(ctx);

  useEffect(() => {
    sessionsStore.load(projectDir);
  }, [projectDir]);

  const slashItems = toPaletteItems(commands, { screen, phase, onError: feedbackStore.setError }).filter(item =>
    item.availableOn.includes(screen),
  );

  const modeItems = WORKFLOW_MODES.map(mode => ({
    label: mode,
    description: `Switch to ${mode} mode`,
    action: () => { ctx.setWorkflowMode(mode); },
  }));

  const pickerItems = [
    {
      label: 'Planner',
      description: 'Select planner tool',
      action: () => { overlayStore.open('planner-picker'); },
    },
    {
      label: 'Implementer',
      description: 'Select implementer',
      action: () => { overlayStore.open('implementer-picker'); },
    },
    {
      label: 'Sessions',
      description: 'Browse past sessions',
      action: () => { overlayStore.open('sessions'); },
    },
    {
      label: 'Settings',
      description: 'Planner, model & settings',
      action: () => { overlayStore.open('settings'); },
    },
  ];

  const taskItems =
    phase === 'implementing' || phase === 'validating-task' || phase === 'escalating'
      ? tasks.map(t => ({
          id: t.id,
          title: t.title,
          action: () => { feedbackStore.setMessage(`Task ${t.id}: ${t.title}`); },
        }))
      : [];

  const sessionItems = sessions.slice(0, 10).map(s => ({
    id: s.id,
    feature: s.feature,
    status: s.status,
    action: () => {
      if (s.status === 'interrupted') {
        routerStore.navigate({ to: 'workflow', feature: s.feature });
        return;
      }
      if (s.summary) {
        routerStore.navigate({ to: 'summary', summary: s.summary, sessionId: s.id });
        return;
      }
      feedbackStore.setMessage(`Session "${s.feature}" failed without a summary to display`);
    },
  }));

  const customItems = (config.palette?.customActions ?? []).map(a => ({
    id: a.id,
    label: a.label,
    description: a.description ?? '',
    action: () => { void executeSlashCommand(commands, a.command, { screen, phase, onError: feedbackStore.setError }); },
  }));

  const results = buildPaletteResults({
    query,
    slashItems,
    modeItems,
    pickerItems,
    taskItems,
    sessionItems,
    customItems,
    mruIds,
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
          paletteMruStore.record(item.id);
          overlayStore.close();
          void Promise.resolve(item.action()).catch((err: unknown) => {
            feedbackStore.setError(err instanceof Error ? err.message : String(err));
          });
        }
        return;
      }
      if (key.upArrow) {
        setCursor(c => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor(c => Math.min(results.length - 1, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery(q => q.slice(0, -1));
        setCursor(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery(q => q + input);
        setCursor(0);
      }
    },
    { isActive: true },
  );

  const t = useTheme();

  const scrollOffset = Math.max(0, Math.min(cursor - Math.floor(MAX_VISIBLE / 2), results.length - MAX_VISIBLE));
  const visible = results.slice(scrollOffset, scrollOffset + MAX_VISIBLE);

  return (
    <OverlayPanel
      title="Command Palette"
      hint={'↑↓ navigate  Enter select  Esc close'}
    >
      <Box marginBottom={1}>
        <Text color={t.textDim}>{'❯ '}</Text>
        <Text>{query}</Text>
        <Text color={t.accent}>{'_'}</Text>
      </Box>

      <Box flexDirection="column">
        {visible.length === 0 && query.length > 0 && (
          <Text color={t.textDim}>  No matching commands</Text>
        )}
        {visible.map((result, i) => {
          const globalIndex = scrollOffset + i;
          const isCursor = globalIndex === cursor;
          return (
            <ResultRow key={result.id} result={result} isCursor={isCursor} />
          );
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
      <Text>{' '}</Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{result.label}</Text>
      {result.description ? (
        <>
          <Text>{' '}</Text>
          <Text color={t.textDim}>{result.description}</Text>
        </>
      ) : null}
      {result.shortcut ? (
        <>
          <Text>{' '}</Text>
          <Text color={t.textDim}>{`[${result.shortcut}]`}</Text>
        </>
      ) : null}
    </Box>
  );
}
