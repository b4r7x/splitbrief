import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { planEditorStore, type PlanEditorFocus } from '../../../../stores/workflow/plan-editor.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
} from '../../../../utils/display-text.js';

interface FooterBinding {
  key: string;
  label: string;
}

export interface PlanEditorHelpRow {
  context: string;
  key: string;
  label: string;
}

interface ContextualBindingsInput {
  tasks: { length: number };
  cursor: number;
  dirty: boolean;
  flaggedIds: ReadonlySet<string>;
  isPacketPreviewOpen: boolean;
  focus: PlanEditorFocus;
  loadFailed?: boolean | undefined;
}

export function getContextualBindings(state: ContextualBindingsInput): FooterBinding[] {
  const bindings: FooterBinding[] = [];
  const hasTasks = state.tasks.length > 0;
  const hasFlagged = state.flaggedIds.size > 0;

  if (state.loadFailed) {
    return [
      { key: 'N', label: 'reject' },
      { key: 'q', label: 'discard' },
      { key: '?', label: 'help' },
    ];
  }

  if (state.focus === 'editing-section') {
    return [
      { key: 'enter', label: 'newline' },
      { key: '^enter', label: 'save field' },
      { key: 'esc', label: 'cancel field' },
    ];
  }

  if (state.focus === 'regen-reason') {
    return [
      { key: 'enter', label: 'regen flagged' },
      { key: 'esc', label: 'cancel regen' },
    ];
  }

  if (state.focus === 'section-list') {
    bindings.push({ key: 'j/k', label: 'section' });
    bindings.push({ key: 'e', label: 'edit section' });
    bindings.push({ key: 'c', label: 'copy section' });
    bindings.push({ key: 'esc', label: 'tasks' });
    bindings.push({ key: 'Y', label: state.dirty ? 'save draft' : 'approve checks' });
    bindings.push({ key: 'N', label: 'reject' });
    bindings.push({ key: 'q', label: 'discard' });
    bindings.push({ key: '?', label: 'help' });
    return bindings;
  }

  if (hasTasks) {
    bindings.push({ key: 'j/k', label: 'navigate' });
  }

  if (hasTasks) {
    bindings.push({ key: 'enter', label: 'expand' });
    bindings.push({ key: 'tab', label: 'sections' });
    bindings.push({ key: 'x', label: 'flag' });
    bindings.push({ key: 'c', label: 'copy' });
    bindings.push({ key: 'E', label: 'raw edit' });
    bindings.push({ key: 's', label: 'split' });
    bindings.push({ key: 'd', label: 'delete' });
  }

  if (hasTasks && state.cursor > 0) {
    bindings.push({ key: 'm', label: 'merge' });
  }

  if (state.tasks.length > 1) {
    bindings.push({ key: '^j/^k', label: 'reorder' });
  }

  if (hasFlagged) {
    bindings.push({ key: 'R', label: `regen ${state.flaggedIds.size} flagged` });
  }

  bindings.push({ key: 'p', label: state.isPacketPreviewOpen ? 'close preview' : 'preview' });

  if (state.dirty) {
    bindings.push({ key: 'Y', label: 'save draft' });
  } else {
    bindings.push({ key: 'Y', label: 'approve checks' });
  }

  bindings.push({ key: 'N', label: 'reject' });
  bindings.push({ key: 'q', label: 'discard' });
  bindings.push({ key: '?', label: 'help' });

  return bindings;
}

export function getPlanEditorHelpRows(): PlanEditorHelpRow[] {
  return [
    ...helpRowsForContext('Tasks', {
      tasks: { length: 2 },
      cursor: 1,
      dirty: false,
      flaggedIds: new Set(['flagged-task']),
      isPacketPreviewOpen: false,
      focus: 'task-list',
      loadFailed: false,
    }),
    ...helpRowsForContext('Sections', {
      tasks: { length: 1 },
      cursor: 0,
      dirty: false,
      flaggedIds: new Set<string>(),
      isPacketPreviewOpen: false,
      focus: 'section-list',
      loadFailed: false,
    }),
    ...helpRowsForContext('Editing', {
      tasks: { length: 1 },
      cursor: 0,
      dirty: true,
      flaggedIds: new Set<string>(),
      isPacketPreviewOpen: false,
      focus: 'editing-section',
      loadFailed: false,
    }),
    ...helpRowsForContext('Regen', {
      tasks: { length: 1 },
      cursor: 0,
      dirty: false,
      flaggedIds: new Set(['flagged-task']),
      isPacketPreviewOpen: false,
      focus: 'regen-reason',
      loadFailed: false,
    }),
  ];
}

function helpRowsForContext(context: string, state: ContextualBindingsInput): PlanEditorHelpRow[] {
  return getContextualBindings(state).map((binding) => ({
    context,
    key: formatHelpKey(binding.key),
    label: binding.label,
  }));
}

function formatHelpKey(key: string): string {
  if (key === '^enter') return 'Ctrl+Enter';
  if (key === '^j/^k') return 'Ctrl+J / Ctrl+K';
  return key;
}

export function formatPlanEditorFooterLines(input: {
  bindings: FooterBinding[];
  width: number;
  isNarrow: boolean;
}): string[] {
  const maxWidth = Math.max(1, input.width);
  const parts = input.bindings.map((binding) =>
    input.isNarrow
      ? `${binding.key} ${binding.label.slice(0, 3)}`
      : `${binding.key} ${binding.label}`,
  );
  const all = parts.join(' · ');
  if (getTerminalCellWidth(all) <= maxWidth) return [all];

  const tail: string[] = [];
  let tailStart = parts.length;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part === undefined) continue;
    const candidate = [part, ...tail].join(' · ');
    if (tail.length > 0 && getTerminalCellWidth(candidate) > maxWidth) break;
    tail.unshift(part);
    tailStart = index;
  }

  const head = parts.slice(0, tailStart).join(' · ');
  const lines = [
    truncateTerminalDisplayText(head, maxWidth),
    truncateTerminalDisplayText(tail.join(' · '), maxWidth),
  ].filter((line) => line.length > 0);
  return lines.length > 0 ? lines : [truncateTerminalDisplayText(all, maxWidth)];
}

export function PlanEditorFooter({
  isPacketPreviewOpen,
  isNarrow,
  width,
  loadFailed = false,
}: {
  isPacketPreviewOpen: boolean;
  isNarrow: boolean;
  width: number;
  loadFailed?: boolean | undefined;
}) {
  const t = useTheme();
  const tasks = planEditorStore.use((s) => s.tasks);
  const cursor = planEditorStore.use((s) => s.cursor);
  const dirty = planEditorStore.use((s) => s.dirty);
  const flaggedIds = planEditorStore.use((s) => s.flaggedIds);
  const focus = planEditorStore.use((s) => s.focus);

  const bindings = getContextualBindings({
    tasks,
    cursor,
    dirty,
    flaggedIds,
    isPacketPreviewOpen,
    focus,
    loadFailed,
  });

  const lines = formatPlanEditorFooterLines({ bindings, width, isNarrow });

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={t.textDim} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

export type { FooterBinding, ContextualBindingsInput };
