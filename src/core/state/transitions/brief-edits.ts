import { fixBriefDescription } from '../../review/fix/task.js';
import { isTaskCompleted, type Task } from '../../schemas/task.js';
import type { WorkflowState } from '../../schemas/workflow/state.js';
import type { ConsultRecord } from '../../schemas/workflow/consult-record.js';
import { assertNever } from '../../../utils/type-guards.js';
import { insertTasksAfter, lineageIdOf } from '../task-insert.js';
import { decisionLedgerText, keepReplacedStart, lineageKeyFor, withLineage } from '../lineage.js';
import type { MachineAction } from '../types.js';
import { retryProfilePin } from './seat.js';

type FamilyAction = Extract<
  MachineAction,
  {
    type:
      | 'RESET_TASK'
      | 'REPLACE_TASK'
      | 'INSERT_TASKS'
      | 'RECORD_CONSULT'
      | 'RECORD_DECISIONS'
      | 'RECORD_CORRECTION';
  }
>;

export function transitionBriefEdits(
  state: WorkflowState,
  action: FamilyAction,
  now: Date,
): WorkflowState {
  switch (action.type) {
    case 'RESET_TASK': {
      const idx = state.tasks.findIndex((t) => t.id === action.taskId);
      if (idx < 0) return state;
      return {
        ...state,
        tasks: state.tasks.map((t, i) => (i === idx ? { ...t, status: 'pending' } : t)),
        currentTaskIndex: idx,
        attempt: 0,
        phase: 'implementing',
        ...(state.pendingRecovery?.taskId === action.taskId ? { pendingRecovery: undefined } : {}),
        ...retryProfilePin(action),
      };
    }

    case 'REPLACE_TASK': {
      const index = state.tasks.findIndex((t) => t.id === action.taskId);
      const previous = index < 0 ? undefined : state.tasks[index];
      if (previous === undefined) return state;
      const replacement: Task = {
        ...action.task,
        id: previous.id,
        ...(previous.fix !== undefined && {
          fix: previous.fix,
          description: fixBriefDescription(action.task.description, previous.fix.findings),
        }),
        ...(previous.parentId !== undefined && { parentId: previous.parentId }),
        criteria: previous.criteria,
        status: 'pending',
        revision: (previous.revision ?? 1) + 1,
      };
      return {
        ...keepReplacedStart(state, lineageIdOf(previous)),
        tasks: state.tasks.map((task, i) => (i === index ? replacement : task)),
        attempt: 0,
      };
    }

    case 'INSERT_TASKS': {
      if (action.parentId === null) {
        if (action.afterTaskId === undefined) {
          return { ...state, tasks: [...state.tasks, ...action.tasks] };
        }
        const anchorIndex = state.tasks.findIndex((task) => task.id === action.afterTaskId);
        const insertAt = anchorIndex < 0 ? state.tasks.length : anchorIndex + 1;
        return {
          ...state,
          tasks: insertTasksAfter(state.tasks, action.tasks, action.afterTaskId),
          currentTaskIndex: Math.min(state.currentTaskIndex, insertAt),
        };
      }
      const parentIndex = state.tasks.findIndex((t) => t.id === action.parentId);
      const parent = parentIndex < 0 ? undefined : state.tasks[parentIndex];
      if (parent === undefined) return state;
      const lineageKey = lineageIdOf(parent);
      const children = action.tasks.map((task) => ({
        ...task,
        parentId: lineageKey,
        ...(parent.fix !== undefined && {
          fix: parent.fix,
          description: fixBriefDescription(task.description, parent.fix.findings),
        }),
      }));
      const childIds = children.map((task) => task.id);
      const remaining = state.tasks
        .filter((task) => task.id !== parent.id)
        .map((task) => {
          if (isTaskCompleted(task.status) || !task.dependsOn.includes(parent.id)) return task;
          return {
            ...task,
            dependsOn: [
              ...new Set(task.dependsOn.flatMap((dep) => (dep === parent.id ? childIds : [dep]))),
            ],
          };
        });
      const tasks = [
        ...remaining.slice(0, parentIndex),
        ...children,
        ...remaining.slice(parentIndex),
      ];
      const shift = parentIndex < state.currentTaskIndex ? children.length - 1 : 0;
      // A split last fix task hands its open fix cycle to its last child, the brief reviewed last.
      const open = state.fixCycles?.open;
      const lastChildId = childIds.at(-1);
      return {
        ...withLineage(keepReplacedStart(state, lineageKey), lineageKey, (lineage) => ({
          ...lineage,
          replacedParents: [...lineage.replacedParents, parent],
        })),
        tasks,
        currentTaskIndex: state.currentTaskIndex + shift,
        ...(state.fixCycles !== undefined &&
          open?.lastFixTaskId === parent.id &&
          lastChildId !== undefined && {
            fixCycles: { ...state.fixCycles, open: { ...open, lastFixTaskId: lastChildId } },
          }),
      };
    }

    case 'RECORD_CONSULT': {
      const record: ConsultRecord = {
        reason: action.reason,
        action: action.answer.answer.action,
        diagnosis: action.answer.answer.diagnosis,
        at: now.toISOString(),
        taskId: action.taskId,
        revision: action.revision,
        answer: action.answer,
      };
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
        ...lineage,
        consultRecords: [...lineage.consultRecords, { ...record, afterAttempt: lineage.attempts }],
      }));
    }

    case 'RECORD_DECISIONS': {
      if (state.plan === undefined) return state;
      const recorded = state.plan.decisions;
      const added = [...new Set(action.decisions.map(decisionLedgerText))]
        .filter(
          (text) =>
            !recorded.some((entry) => entry.taskId === action.taskId && entry.text === text),
        )
        .map((text) => ({ text, taskId: action.taskId }));
      if (added.length === 0) return state;
      return { ...state, plan: { ...state.plan, decisions: [...recorded, ...added] } };
    }

    case 'RECORD_CORRECTION':
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
        ...lineage,
        corrections: [...(lineage.corrections ?? []), action.text],
      }));

    default:
      return assertNever(action);
  }
}
