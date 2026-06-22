import { basename, resolve } from 'node:path';
import { TASKS_FILE } from '../../../core/paths.js';
import { writeSpecFile, type SpecFileRef, type SpecMetadata } from '../../../core/paths-io.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { parseTasksStrict } from '../../../engine/spec/parser.js';
import {
  evaluateBriefQuality,
  firstBriefErrorMessage,
  type BriefQualityReport,
} from '../../../engine/spec/brief-quality.js';
import { writeBriefQuality } from '../../../engine/orchestrator/planning/brief-quality-gate.js';
import {
  firstBriefReadinessBlockMessage,
  runBriefReadinessGate,
} from '../../../engine/orchestrator/planning/brief-readiness-gate.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import { getWorkflowMode } from '../../../core/config/accessors/values.js';
import { configStore } from '../../../stores/project/config.js';
import {
  PLAN_EDITOR_STALE_SAVE_ERROR,
  planEditorStore,
} from '../../../stores/workflow/plan-editor.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { Task } from '../../../core/schemas/task.js';

export interface SaveHandlerOptions {
  onApprove?: (() => void) | undefined;
  onQualityUpdated?: ((report: BriefQualityReport) => void) | undefined;
}

function sameTaskIds(a: Task[], b: Task[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((task) => task.id));
  if (ids.size !== a.length) return false;
  if (new Set(b.map((task) => task.id)).size !== b.length) return false;
  for (const task of b) {
    if (!ids.has(task.id)) return false;
  }
  return true;
}

function specFileRefFor(sessionDirPath: string): SpecFileRef {
  const sessionDir = resolve(sessionDirPath);
  return {
    projectDir: resolve(sessionDir, '..', '..', '..'),
    sessionId: basename(sessionDir),
  };
}

function sessionSpecMetadata(): SpecMetadata | null {
  const config = configStore.get().config;
  if (!config) return null;
  return { ...runPricingIdentity(config), mode: getWorkflowMode(config) };
}

function normalizeOptions(options?: SaveHandlerOptions | (() => void)): SaveHandlerOptions {
  return typeof options === 'function' ? { onApprove: options } : (options ?? {});
}

async function approveTasks(opts: {
  tasks: Task[];
  revision: number;
  sessionDirPath: string;
  report: BriefQualityReport;
  onApprove?: (() => void) | undefined;
  onQualityUpdated?: ((report: BriefQualityReport) => void) | undefined;
}): Promise<void> {
  const { tasks, revision, sessionDirPath, report, onApprove, onQualityUpdated } = opts;
  const ref = specFileRefFor(sessionDirPath);
  writeBriefQuality(ref, report);
  onQualityUpdated?.(report);

  if (!report.passed) {
    planEditorStore.setSaveError(`Brief quality failed: ${firstBriefErrorMessage(report)}`);
    return;
  }

  const { config, projectDir } = configStore.get();
  if (!config) {
    planEditorStore.setSaveError(
      'Task Brief approval blocked: routing readiness unavailable. Next best action: reload project config before approval.',
    );
    return;
  }

  const readiness = await runBriefReadinessGate({
    tasks,
    config,
    projectDir: projectDir || ref.projectDir,
  });
  planEditorStore.setReviewMetadata(readiness.metadata);

  if (planEditorStore.get().revision !== revision) {
    planEditorStore.setSaveError(PLAN_EDITOR_STALE_SAVE_ERROR);
    return;
  }

  if (!readiness.ok) {
    planEditorStore.setSaveError(firstBriefReadinessBlockMessage(readiness));
    return;
  }

  onApprove?.();
}

export function createSaveHandler(
  sessionDirPath: string,
  options?: SaveHandlerOptions | (() => void),
): () => Promise<void> {
  const { onApprove, onQualityUpdated } = normalizeOptions(options);
  return async () => {
    const { tasks, revision, dirty } = planEditorStore.get();
    const markdown = formatTasks(tasks);

    let parsed: Task[];
    try {
      parsed = parseTasksStrict(markdown);
    } catch (err) {
      planEditorStore.setSaveError(`Round-trip parse failed: ${toErrorMessage(err)}`);
      return;
    }

    if (!sameTaskIds(parsed, tasks)) {
      planEditorStore.setSaveError('Round-trip validation failed. Tasks not saved.');
      return;
    }

    if (planEditorStore.get().revision !== revision) {
      planEditorStore.setSaveError(PLAN_EDITOR_STALE_SAVE_ERROR);
      return;
    }

    const ref = specFileRefFor(sessionDirPath);
    try {
      writeSpecFile(ref, TASKS_FILE, markdown, sessionSpecMetadata());
    } catch (err) {
      planEditorStore.setSaveError(`Failed to save: ${toErrorMessage(err)}`);
      return;
    }

    if (!planEditorStore.markSavedIfRevision(revision)) return;
    const report = evaluateBriefQuality(parsed);

    if (dirty) {
      writeBriefQuality(ref, report);
      onQualityUpdated?.(report);
      planEditorStore.setStatusMessage(
        report.passed ? 'draft saved' : 'draft saved; fix quality issues before approval',
      );
      return;
    }

    await approveTasks({
      tasks: parsed,
      revision,
      sessionDirPath,
      report,
      onApprove,
      onQualityUpdated,
    });
  };
}
