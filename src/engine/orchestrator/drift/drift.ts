import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { DRIFT_REPORT_FILE, sessionDir } from '../../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../../lib/fs.js';
import { countBySeverity } from '../../../utils/collections.js';
import { isDriftReport, type DriftFinding, type DriftReport } from '../../../core/schemas/drift.js';

export type AnalyzeBriefDriftInput = {
  tasks: Task[];
  changedFiles: string[];
  diff: string;
  ledger?: EvidenceLedger | null | undefined;
  briefHash?: string | null;
};

function isFailedOrSkipped(status: Task['status']): boolean {
  return status === 'failed' || status === 'skipped';
}

function isCompleted(status: Task['status']): boolean {
  return status === 'done' || status === 'escalated';
}

export function analyzeBriefDrift(input: AnalyzeBriefDriftInput): DriftReport {
  const findings: DriftFinding[] = [];
  const expectedFiles = Array.from(new Set(input.tasks.map(t => t.file).filter(Boolean)));
  const expectedSet = new Set(expectedFiles);
  const changedFiles = Array.from(new Set(input.changedFiles));
  const changedSet = new Set(changedFiles);

  // Collect explicit out-of-bounds patterns from any task scope
  const outOfBoundsPatterns: string[] = [];
  for (const task of input.tasks) {
    for (const p of task.scope?.outOfBounds ?? []) {
      if (p) outOfBoundsPatterns.push(p);
    }
  }
  const hasExplicitOutOfBounds = outOfBoundsPatterns.length > 0;

  // Out-of-bounds file path or quoted symbol matches anywhere in changed files / diff
  for (const pattern of outOfBoundsPatterns) {
    const fileHit = changedFiles.find(f => f.includes(pattern));
    if (fileHit) {
      findings.push({
        severity: 'error',
        code: 'out_of_bounds_text_match',
        file: fileHit,
        message: `Out-of-bounds pattern "${pattern}" matched changed file ${fileHit}.`,
      });
      continue;
    }
    if (input.diff.includes(pattern)) {
      findings.push({
        severity: 'error',
        code: 'out_of_bounds_text_match',
        message: `Out-of-bounds pattern "${pattern}" appears in diff.`,
      });
    }
  }

  // Extra changed file not targeted by any task
  for (const file of changedFiles) {
    if (!expectedSet.has(file)) {
      findings.push({
        severity: hasExplicitOutOfBounds ? 'error' : 'warning',
        code: 'out_of_scope_file',
        file,
        message: `${file} was changed but no Task Brief targets it.`,
      });
    }
  }

  // Done/escalated task target file absent
  for (const task of input.tasks) {
    if (isCompleted(task.status) && task.file && !changedSet.has(task.file)) {
      findings.push({
        severity: 'warning',
        code: 'missing_expected_file',
        taskId: task.id,
        file: task.file,
        message: `Task ${task.id} reached ${task.status} but ${task.file} was not changed.`,
      });
    }
  }

  // Failed task with changed file
  for (const task of input.tasks) {
    if (task.status === 'failed' && task.file && changedSet.has(task.file)) {
      findings.push({
        severity: 'error',
        code: 'failed_task_with_diff',
        taskId: task.id,
        file: task.file,
        message: `Failed task ${task.id} left changes in ${task.file}.`,
      });
    }
  }

  // Diff exists while all tasks are failed/skipped -> orphan diff
  if (changedFiles.length > 0 && input.tasks.length > 0 && input.tasks.every(t => isFailedOrSkipped(t.status))) {
    findings.push({
      severity: 'error',
      code: 'orphan_diff',
      message: `Diff contains ${changedFiles.length} file(s) but every task is failed or skipped.`,
    });
  }

  // Missing expected evidence (when ledger present)
  if (input.ledger) {
    for (const entry of input.ledger.tasks) {
      if (!isCompleted(entry.status)) continue;
      if (entry.expectedEvidence.length === 0) continue;
      if (entry.observedEvidence.length === 0) {
        findings.push({
          severity: 'warning',
          code: 'missing_evidence',
          taskId: entry.id,
          message: `Task ${entry.id} expected evidence but none was observed.`,
        });
      }
    }
  }

  let score = 1;
  let errorCount = 0;
  for (const f of findings) {
    if (f.severity === 'error') { score -= 0.25; errorCount += 1; }
    else if (f.severity === 'warning') { score -= 0.08; }
  }
  score = Math.max(0, Math.min(1, score));

  return {
    version: 1,
    passed: errorCount === 0,
    score,
    changedFiles,
    expectedFiles,
    findings,
    briefHash: input.briefHash ?? null,
  };
}

export function driftReportPath(projectDir: string, sessionId: string): string {
  return join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE);
}

export function writeDriftReport(
  projectDir: string,
  sessionId: string,
  report: DriftReport,
): void {
  writeSecureFile(
    driftReportPath(projectDir, sessionId),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

export function readDriftReport(projectDir: string, sessionId: string): DriftReport | null {
  const raw = readJsonSafe(driftReportPath(projectDir, sessionId));
  if (raw === null) return null;
  if (!isDriftReport(raw)) return null;
  return { ...raw, briefHash: raw.briefHash ?? null };
}

export function formatDriftReportForPrompt(report: DriftReport): string {
  const lines: string[] = [];
  lines.push(`passed: ${report.passed}`);
  lines.push(`score: ${report.score.toFixed(2)}`);
  if (report.findings.length === 0) {
    lines.push('findings: none');
  } else {
    lines.push('findings:');
    for (const f of report.findings) {
      lines.push(`- [${f.severity}] ${f.code}: ${f.message}`);
    }
  }
  return lines.join('\n');
}

export function publishDriftReport(bus: EventBus, phase: Phase, report: DriftReport): void {
  const { error: errorCount, warning: warningCount } = countBySeverity(report.findings);
  const event: EngineEvent = {
    type: 'drift_report',
    ts: Date.now(),
    phase,
    passed: report.passed,
    score: report.score,
    errorCount,
    warningCount,
  };
  bus.publish(event);
}
