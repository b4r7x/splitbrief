import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { planEditorStore, type PlanEditorFocus } from '../../../../stores/workflow/plan-editor.js';

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
}

export function getContextualBindings(state: ContextualBindingsInput): FooterBinding[] {
  const bindings: FooterBinding[] = [];
  const hasTasks = state.tasks.length > 0;
  const hasFlagged = state.flaggedIds.size > 0;

  if (state.focus === 'editing-section') {
    return [
      { key: 'enter', label: 'newline' },
      { key: '^enter', label: 'save field' },
      { key: 'esc', label: 'cancel field' },
    ];
  }

  if (state.focus === 'section-list') {
    bindings.push({ key: 'j/k', label: 'section' });
    bindings.push({ key: 'e', label: 'edit section' });
    bindings.push({ key: 'c', label: 'copy section' });
    bindings.push({ key: 'esc', label: 'tasks' });
    bindings.push({ key: 'Y', label: state.dirty ? 'save' : 'approve' });
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
    bindings.push({ key: 'Y', label: 'save' });
  } else {
    bindings.push({ key: 'Y', label: 'approve' });
  }

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
    }),
    ...helpRowsForContext('Sections', {
      tasks: { length: 1 },
      cursor: 0,
      dirty: false,
      flaggedIds: new Set<string>(),
      isPacketPreviewOpen: false,
      focus: 'section-list',
    }),
    ...helpRowsForContext('Editing', {
      tasks: { length: 1 },
      cursor: 0,
      dirty: true,
      flaggedIds: new Set<string>(),
      isPacketPreviewOpen: false,
      focus: 'editing-section',
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

export function PlanEditorFooter({
  isPacketPreviewOpen,
  isNarrow,
}: {
  isPacketPreviewOpen: boolean;
  isNarrow: boolean;
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
  });

  const formatBinding = (b: FooterBinding): string =>
    isNarrow ? `${b.key} ${b.label.slice(0, 3)}` : `${b.key} ${b.label}`;

  const midpoint = Math.ceil(bindings.length / 2);
  const line1 = bindings.slice(0, midpoint);
  const line2 = bindings.slice(midpoint);

  return (
    <Box flexDirection="column">
      <Text color={t.textDim} wrap="truncate">
        {line1.map(formatBinding).join(' · ')}
      </Text>
      {line2.length > 0 && (
        <Text color={t.textDim} wrap="truncate">
          {line2.map(formatBinding).join(' · ')}
        </Text>
      )}
    </Box>
  );
}

export type { FooterBinding, ContextualBindingsInput };
