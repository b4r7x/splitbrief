import { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { editorStore } from '../../stores/ui/editor.js';
import { externalEditRequestStore } from '../../stores/ui/external-edit-request.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { writeSpecFile, type SpecFileRef } from '../../core/paths-io.js';
import { TASKS_FILE } from '../../core/paths.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import type { Task } from '../../core/schemas/task.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import {
  briefFieldList,
  readField,
  writeField,
  type EditableBriefField,
} from './brief-field-model.js';
import { checkBriefSave } from './brief-save.js';
import { FieldEditorView } from './field-editor-view.js';
import { useEditorKeys } from './use-editor-keys.js';
import { useFieldSessionOwned } from './use-field-session-owned.js';

interface BriefFieldEditorProps {
  tasks: Task[];
  taskIndex: number;
  sessionRef: SpecFileRef;
  resolve: (result: ApprovalReviewResult) => void;
  height: number;
}

// Rows this surface reserves outside the field viewport: identity (1), inline error (1), and the
// decision controls (1). The error row is reserved even when no error is showing so the save-failure
// reason and the controls both stay inside the region when checkBriefSave rejects (CON-D).
const FIELD_CHROME_ROWS = 3;

export function BriefFieldEditor({
  tasks,
  taskIndex,
  sessionRef,
  resolve,
  height,
}: BriefFieldEditorProps) {
  const t = useTheme();
  const baseTask = tasks[taskIndex];
  const fieldList = baseTask ? briefFieldList(baseTask) : [];
  const session = editorStore.use((s) => (s.status === 'open' && s.surface === 'field' ? s : null));
  const owns = useFieldSessionOwned();
  const [workingTask, setWorkingTask] = useState<Task | null>(baseTask ?? null);
  const [field, setField] = useState<EditableBriefField>(fieldList[0] ?? 'title');
  const [error, setError] = useState<string | null>(null);

  // The trigger opens an EMPTY field session (it has no access to the parsed brief model); this
  // component owns the model, so it seeds the buffer once from the focused Task via readField.
  // Seeding through openField mirrors switchField and keeps the store the single source of truth.
  const seeded = useRef(false);
  useEffect(() => {
    if (!owns || baseTask === undefined || seeded.current) return;
    const state = editorStore.get();
    if (state.status !== 'open') return;
    seeded.current = true;
    editorStore.openField({
      filePath: state.filePath,
      value: readField(baseTask, field),
      ownerToken: state.ownerToken,
      layout: state.layout,
    });
  }, [owns, baseTask, field]);

  const switchField = (direction: 1 | -1) => {
    const state = editorStore.get();
    if (state.status !== 'open' || workingTask === null || fieldList.length === 0) return;
    const committed = writeField(workingTask, field, state.value);
    setWorkingTask(committed);
    const currentIndex = fieldList.indexOf(field);
    const nextIndex = (currentIndex + direction + fieldList.length) % fieldList.length;
    const nextField = fieldList[nextIndex] ?? field;
    setField(nextField);
    setError(null);
    editorStore.openField({
      filePath: state.filePath,
      value: readField(committed, nextField),
      ownerToken: state.ownerToken,
      layout: state.layout,
    });
  };

  const handleSave = () => {
    const state = editorStore.get();
    if (state.status !== 'open' || workingTask === null) return;
    if (reviewStore.get().ownerToken !== state.ownerToken) return;
    const committed = writeField(workingTask, field, state.value);
    const next = tasks.map((task, index) => (index === taskIndex ? committed : task));
    const check = checkBriefSave(next);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    editorStore.beginSubmit();
    writeSpecFile(sessionRef, TASKS_FILE, formatTasks(next), null);
    resolve({ approved: false, action: 'edit' });
    editorStore.close();
  };

  const handleCancel = () => {
    editorStore.close();
  };

  const handleOpenExternal = () => {
    const state = editorStore.get();
    if (state.status !== 'open') return;
    editorStore.close();
    externalEditRequestStore.request(state.ownerToken);
  };

  useEditorKeys({
    surface: 'field',
    onSave: handleSave,
    onCancel: handleCancel,
    onOpenExternal: handleOpenExternal,
    onFieldNext: () => switchField(1),
    onFieldPrev: () => switchField(-1),
  });

  if (session === null || !owns) return null;

  const identity = baseTask ? `${baseTask.id} · ${field}` : field;
  const fieldMaxRows = Math.max(1, height - FIELD_CHROME_ROWS);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.accent}>{identity}</Text>
      </Box>
      <FieldEditorView maxRows={fieldMaxRows} />
      {error !== null && (
        <Box>
          <Text color={t.error}>{error}</Text>
        </Box>
      )}
      <Box width="100%" overflow="hidden">
        <Text color={t.textDim} wrap="truncate">
          Tab field · Ctrl+S save · Ctrl+O tasks.md (discards edit) · Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
