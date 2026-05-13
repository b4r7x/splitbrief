import type { CostPrediction, PlannerEstimateReview } from '../../core/schemas/summary.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import { TaskIdSchema, taskId } from '../../core/schemas/task.js';
import { topoSort } from '../../core/state/topo-sort.js';
import { CONCRETE_FILE_PATH_PATTERN } from '../../utils/path-patterns.js';

type DeterministicEstimate = NonNullable<CostPrediction['deterministic']>;
type DeterministicTaskEstimate = DeterministicEstimate['tasks'][number];

export type AutoSplitOverflowSkippedSplitCode =
  | 'too-many-child-tasks'
  | 'empty-child-task'
  | 'lost-acceptance-criteria'
  | 'lost-dependencies'
  | 'excessive-duplicated-ownership'
  | 'no-safe-split';

export interface AutoSplitOverflowSkippedSplit {
  taskId: TaskId;
  code: AutoSplitOverflowSkippedSplitCode;
  reason: string;
}

export interface AutoSplitOverflowPreview {
  parentTaskId: TaskId;
  childTaskIds: TaskId[];
  reason: 'overflow' | 'tight-low-confidence' | 'planner-split-suggested';
}

export interface AutoSplitOverflowResult {
  changed: boolean;
  tasks: Task[];
  previews: AutoSplitOverflowPreview[];
  skippedSplits: AutoSplitOverflowSkippedSplit[];
}

export interface AutoSplitOverflowOptions {
  enabled?: boolean | undefined;
  tasks: Task[];
  estimate: DeterministicEstimate;
  plannerReview?: PlannerEstimateReview | undefined;
}

interface Candidate {
  task: Task;
  reason: AutoSplitOverflowPreview['reason'];
}

interface DraftTask {
  task: Task;
  originalDependsOn: TaskId[];
}

const MAX_CHILD_TASKS = 4;
const MAX_DUPLICATE_FILE_OWNERSHIP = 2;
const TASK_ID_NUMBER_PATTERN = /^T(\d+)$/;

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function nextTaskId(index: number): TaskId {
  return taskId(`T${String(index).padStart(3, '0')}`);
}

function taskIdNumber(id: TaskId): number | null {
  const numericPart = TASK_ID_NUMBER_PATTERN.exec(id)?.[1];
  if (!numericPart) return null;
  return Number.parseInt(numericPart, 10);
}

function nextFreshTaskIdIndex(tasks: Task[]): number {
  let highest = 0;
  for (const task of tasks) {
    const numericId = taskIdNumber(task.id);
    if (numericId !== null && numericId > highest) highest = numericId;
  }
  return highest + 1;
}

function estimateByTaskId(estimate: DeterministicEstimate): Map<TaskId, DeterministicTaskEstimate> {
  const estimates = new Map<TaskId, DeterministicTaskEstimate>();
  for (const taskEstimate of estimate.tasks) {
    const parsed = TaskIdSchema.safeParse(taskEstimate.taskId);
    if (parsed.success) estimates.set(parsed.data, taskEstimate);
  }
  return estimates;
}

function splitSuggestedIds(review: PlannerEstimateReview | undefined): Set<TaskId> {
  if (review?.status !== 'completed' || review.classification !== 'split-suggested') return new Set();
  const ids: TaskId[] = [];
  for (const id of review.affectedTaskIds) {
    const parsed = TaskIdSchema.safeParse(id);
    if (parsed.success) ids.push(parsed.data);
  }
  return new Set(ids);
}

function candidateForTask(
  task: Task,
  estimate: DeterministicTaskEstimate | undefined,
  suggestedIds: ReadonlySet<TaskId>,
): Candidate | null {
  if (suggestedIds.has(task.id)) return { task, reason: 'planner-split-suggested' };
  if (!estimate) return null;
  if (estimate.contextFit === 'overflow') return { task, reason: 'overflow' };
  if (estimate.contextFit === 'tight' && estimate.contextConfidence !== 'context-explicit') {
    return { task, reason: 'tight-low-confidence' };
  }
  return null;
}

function taskText(task: Task): string {
  return [
    task.description,
    ...task.implementationSteps,
    ...task.tests,
    ...task.constraints,
    ...(task.scope?.inBounds ?? []),
    ...(task.escalation ?? []),
    ...(task.evidence ?? []),
  ].join('\n');
}

function referencedFiles(task: Task): string[] {
  return unique([task.file, ...(taskText(task).match(CONCRETE_FILE_PATH_PATTERN) ?? [])]);
}

function matchingItems(items: string[], needle: string): string[] {
  const lower = needle.toLowerCase();
  return items.filter(item => item.toLowerCase().includes(lower));
}

function splitEvenly(items: string[], parts: number): string[][] {
  const result = Array.from({ length: parts }, () => [] as string[]);
  for (let i = 0; i < items.length; i++) {
    result[i % parts]?.push(items[i] ?? '');
  }
  return result.map(group => group.filter(item => item.length > 0));
}

function childScope(parent: Task, focus: string): Task['scope'] {
  const scope: NonNullable<Task['scope']> = {};
  const inBounds = unique([...(parent.scope?.inBounds ?? []), focus]);
  const outOfBounds = parent.scope?.outOfBounds ?? [];
  if (inBounds.length > 0) scope.inBounds = inBounds;
  if (outOfBounds.length > 0) scope.outOfBounds = outOfBounds;
  return scope;
}

function childTask(parent: Task, opts: {
  titleSuffix: string;
  focus: string;
  file: string;
  tests: string[];
  implementationSteps: string[];
  dependsOn: TaskId[];
}): Task {
  const { currentCode, ...parentWithoutCurrentCode } = parent;
  const codeContext = opts.file === parent.file && currentCode !== undefined ? { currentCode } : {};
  return {
    ...parentWithoutCurrentCode,
    ...codeContext,
    id: parent.id,
    title: `${parent.title} (${opts.titleSuffix})`,
    file: opts.file,
    action: opts.file === parent.file ? parent.action : 'modify',
    description: `Parent ${parent.id} intent: ${parent.description}\n\nChild focus: ${opts.focus}.`,
    dependsOn: opts.dependsOn,
    tests: opts.tests,
    implementationSteps: opts.implementationSteps,
    scope: childScope(parent, opts.focus),
    status: 'pending',
  };
}

function splitByFiles(task: Task): Task[] | null {
  const files = referencedFiles(task);
  if (files.length < 2) return null;
  if (files.length > MAX_CHILD_TASKS) return null;

  return files.map(file => {
    const tests = matchingItems(task.tests, file);
    const steps = matchingItems(task.implementationSteps, file);
    return childTask(task, {
      titleSuffix: file,
      focus: file,
      file,
      tests: tests.length > 0 ? tests : task.tests,
      implementationSteps: steps.length > 0 ? steps : [`Apply the parent implementation intent for ${file}.`],
      dependsOn: task.dependsOn,
    });
  });
}

function splitByAcceptanceCriteria(task: Task): Task[] | null {
  if (task.tests.length < 2) return null;
  const childCount = task.tests.length;
  const testGroups = splitEvenly(task.tests, childCount);
  const stepGroups = splitEvenly(task.implementationSteps, childCount);
  return testGroups.map((tests, index) => childTask(task, {
    titleSuffix: `acceptance ${index + 1}`,
    focus: `acceptance criteria ${index + 1}`,
    file: task.file,
    tests,
    implementationSteps: stepGroups[index]?.length ? stepGroups[index] ?? [] : task.implementationSteps,
    dependsOn: task.dependsOn,
  }));
}

function splitByImplementationSteps(task: Task): Task[] | null {
  if (task.implementationSteps.length < 2) return null;
  const childCount = 2;
  const stepGroups = splitEvenly(task.implementationSteps, childCount);
  return stepGroups.map((steps, index) => childTask(task, {
    titleSuffix: `step group ${index + 1}`,
    focus: `implementation step group ${index + 1}`,
    file: task.file,
    tests: task.tests,
    implementationSteps: steps,
    dependsOn: task.dependsOn,
  }));
}

function splitTask(task: Task): Task[] | null {
  return splitByFiles(task) ?? splitByAcceptanceCriteria(task) ?? splitByImplementationSteps(task);
}

function validationSkippedSplit(parent: Task, children: Task[] | null): AutoSplitOverflowSkippedSplit | null {
  if (!children || children.length < 2) {
    return { taskId: parent.id, code: 'no-safe-split', reason: 'No deterministic file, acceptance, or step split was safe.' };
  }
  if (children.length > MAX_CHILD_TASKS) {
    return { taskId: parent.id, code: 'too-many-child-tasks', reason: `Split would create ${children.length} child tasks.` };
  }
  if (children.some(child => child.title.trim() === '' || child.file.trim() === '' || child.description.trim() === '' || child.tests.length === 0 || child.implementationSteps.length === 0)) {
    return { taskId: parent.id, code: 'empty-child-task', reason: 'Split would create an empty child task or a child without checks/steps.' };
  }

  const survivingTests = new Set(children.flatMap(child => child.tests));
  if (parent.tests.some(test => !survivingTests.has(test))) {
    return { taskId: parent.id, code: 'lost-acceptance-criteria', reason: 'Split would drop parent acceptance criteria.' };
  }

  if (parent.dependsOn.some(dep => children.every(child => !child.dependsOn.includes(dep)))) {
    return { taskId: parent.id, code: 'lost-dependencies', reason: 'Split would drop parent dependencies.' };
  }

  const fileCounts = new Map<string, number>();
  for (const child of children) {
    fileCounts.set(child.file, (fileCounts.get(child.file) ?? 0) + 1);
  }
  if (Array.from(fileCounts.values()).some(count => count > MAX_DUPLICATE_FILE_OWNERSHIP)) {
    return { taskId: parent.id, code: 'excessive-duplicated-ownership', reason: 'Split would duplicate the same file ownership too many times.' };
  }

  return null;
}

function expandDependencies(deps: TaskId[], replacements: ReadonlyMap<TaskId, TaskId[]>): TaskId[] {
  return unique(deps.flatMap(dep => replacements.get(dep) ?? [dep]));
}

function buildExpandedTasks(candidates: Candidate[], tasks: Task[]): { tasks: Task[]; previews: AutoSplitOverflowPreview[]; skippedSplits: AutoSplitOverflowSkippedSplit[] } {
  const candidateById = new Map(candidates.map(candidate => [candidate.task.id, candidate]));
  const replacements = new Map<TaskId, TaskId[]>();
  const drafts: DraftTask[] = [];
  const previews: AutoSplitOverflowPreview[] = [];
  const skippedSplits: AutoSplitOverflowSkippedSplit[] = [];
  let nextId = nextFreshTaskIdIndex(tasks);

  for (const task of tasks) {
    const candidate = candidateById.get(task.id);
    if (!candidate) {
      drafts.push({ task, originalDependsOn: task.dependsOn });
      continue;
    }

    const fileCount = referencedFiles(task).length;
    if (fileCount > MAX_CHILD_TASKS) {
      drafts.push({ task, originalDependsOn: task.dependsOn });
      skippedSplits.push({ taskId: task.id, code: 'too-many-child-tasks', reason: `Split would create at least ${fileCount} file child tasks.` });
      continue;
    }

    const children = splitTask(task);
    const skippedSplit = validationSkippedSplit(task, children);
    if (skippedSplit || !children) {
      drafts.push({ task, originalDependsOn: task.dependsOn });
      skippedSplits.push(skippedSplit ?? { taskId: task.id, code: 'no-safe-split', reason: 'No deterministic split was available.' });
      continue;
    }

    const childIds = children.map(() => nextTaskId(nextId++));
    replacements.set(task.id, childIds);
    previews.push({ parentTaskId: task.id, childTaskIds: childIds, reason: candidate.reason });
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childId = childIds[i];
      if (!child || !childId) continue;
      const sameFilePrevious = i > 0 && children[i - 1]?.file === child.file ? childIds[i - 1] : undefined;
      drafts.push({
        task: { ...child, id: childId },
        originalDependsOn: sameFilePrevious ? unique([...child.dependsOn, sameFilePrevious]) : child.dependsOn,
      });
    }
  }

  return {
    tasks: topoSort(drafts.map(draft => ({
      ...draft.task,
      dependsOn: expandDependencies(draft.originalDependsOn, replacements).filter(dep => dep !== draft.task.id),
    }))),
    previews,
    skippedSplits,
  };
}

export function autoSplitOverflowTasks(opts: AutoSplitOverflowOptions): AutoSplitOverflowResult {
  if (!opts.enabled) {
    return {
      changed: false,
      tasks: opts.tasks,
      previews: [],
      skippedSplits: [],
    };
  }

  const estimates = estimateByTaskId(opts.estimate);
  const suggestedIds = splitSuggestedIds(opts.plannerReview);
  const candidates = opts.tasks
    .map(task => candidateForTask(task, estimates.get(task.id), suggestedIds))
    .filter((candidate): candidate is Candidate => candidate !== null);

  if (candidates.length === 0) {
    return {
      changed: false,
      tasks: opts.tasks,
      previews: [],
      skippedSplits: [],
    };
  }

  const expanded = buildExpandedTasks(candidates, opts.tasks);
  return {
    changed: expanded.previews.length > 0,
    tasks: expanded.previews.length > 0 ? expanded.tasks : opts.tasks,
    previews: expanded.previews,
    skippedSplits: expanded.skippedSplits,
  };
}
