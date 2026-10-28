import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { addEndpointScenario } from '../../../evals/scenarios/add-endpoint.js';
import {
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  PLAN_FILE,
  SESSION_LOG_FILE,
  SPLITBRIEF_DIR,
  STATE_FILE,
  SUMMARY_FILE,
} from '../../../src/core/paths.js';
import { phaseTokenRole } from '../../../src/core/phases.js';
import { DriftReportSchema } from '../../../src/core/schemas/drift.js';
import { EvidenceLedgerSchema } from '../../../src/core/schemas/evidence.js';
import { SessionSchema } from '../../../src/core/schemas/session.js';
import {
  type SessionLogEventEntry,
  SessionLogEventEntrySchema,
} from '../../../src/core/schemas/session-log.js';
import type { Task } from '../../../src/core/schemas/task.js';
import { WorkflowStateSchema } from '../../../src/core/schemas/workflow.js';
import { isRecord } from '../../../src/utils/type-guards.js';

export const PLAIN_LINE =
  /^(phase: [a-z-]+|task T\d{3}: (done|failed) \(.+\)|(review: |task review: |task review T\d{3}: )(passed|failed( \(\d+ blocking\))?|no verdict|stopped|Set aside \S+: .+)|done: \d+ tasks|plan check \S+: ((passed|failed)( · (\d+\.\ds|(\d+h )?\d+m \d+s))? \(.*\)|(not run|refused)( \(.*\))?)|Render .+: ((rendered|failed)( · (\d+\.\ds|(\d+h )?\d+m \d+s))?|(not run|refused)( \(.*\))?)|reviewer checks: (off|none \(.+\))|reviewer check declined: .+ \(.+\)|(reviewer|fix) check V\d+: (passed|failed|refused|not run) \(.+\)|fix check V\d+: ((your|\d+[ \u00a0]of[ \u00a0]your)[ \u00a0]\d+[ \u00a0]failures?[ \u00a0](gone|remains?)|(your[ \u00a0]\d+[ \u00a0]failures?|\d+)[ \u00a0]left[ \u00a0]to[ \u00a0]T\d{3}([ \u00a0]and[ \u00a0](T\d{3}|\d+[ \u00a0]other[ \u00a0]fix[ \u00a0]tasks))?|\d+[ \u00a0]others?[ \u00a0]left[ \u00a0]for[ \u00a0]their[ \u00a0]fix[ \u00a0]tasks[ \u00a0]or[ \u00a0]the[ \u00a0]next[ \u00a0]review|no[ \u00a0]failure[ \u00a0]of[ \u00a0]yours)( · ((your|\d+[ \u00a0]of[ \u00a0]your)[ \u00a0]\d+[ \u00a0]failures?[ \u00a0](gone|remains?)|(your[ \u00a0]\d+[ \u00a0]failures?|\d+)[ \u00a0]left[ \u00a0]to[ \u00a0]T\d{3}([ \u00a0]and[ \u00a0](T\d{3}|\d+[ \u00a0]other[ \u00a0]fix[ \u00a0]tasks))?|\d+[ \u00a0]others?[ \u00a0]left[ \u00a0]for[ \u00a0]their[ \u00a0]fix[ \u00a0]tasks[ \u00a0]or[ \u00a0]the[ \u00a0]next[ \u00a0]review|no[ \u00a0]failure[ \u00a0]of[ \u00a0]yours))* \(.+\)|base re-run V\d+ (new|pre-existing): .+|base re-run V\d+: (passes|fails|refused \(.+\)|not run \(.+\)|(\d+[ \u00a0]new, \d+[ \u00a0]pre-existing, )?\d+[ \u00a0]not verified at the run base( · .+)?|\d+[ \u00a0]new, \d+[ \u00a0]pre-existing|pre-existing · (all \d+ failures|the failure) also fails? before this run's changes))$/;

const DONE_LINE = /^done: (\d+) tasks$/;

export type BriefTiming = Readonly<{ id: string; durationMs: number }>;

export type RunnerCallCounts = Readonly<{ planner: number; implementer: number; review: number }>;

export type SessionDirFacts = Readonly<{
  calls: RunnerCallCounts;
  perBrief: readonly BriefTiming[];
  tasks: readonly Task[];
}>;

/** Returns the `done:` count so the caller can hold it against the run's own records. */
export function assertPlainStdout(stdout: string): number {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const line of lines) {
    expect(line, 'line is outside the --plain grammar').toMatch(PLAIN_LINE);
    expect(() => JSON.parse(line), `line parses as JSON: ${line}`).toThrow();
  }
  expect(lines).toContain('phase: implementing');
  expect(lines).toContain('review: passed');
  const done = lines.find((line) => DONE_LINE.test(line));
  if (done === undefined) throw new Error('stdout carries no `done:` line');
  const completed = Number(DONE_LINE.exec(done)?.[1]);
  expect(completed).toBeGreaterThan(0);
  return completed;
}

export function assertSessionDir(
  sessionDir: string,
  opts: {
    expectedBriefs: Readonly<{ min: number; max: number }>;
    completed: number;
  },
): SessionDirFacts {
  const { tasks } = WorkflowStateSchema.parse(readJson(sessionDir, STATE_FILE));
  expect(tasks.length).toBeGreaterThanOrEqual(opts.expectedBriefs.min);
  expect(tasks.length).toBeLessThanOrEqual(opts.expectedBriefs.max);
  expect(tasks.filter((task) => task.action === 'modify').length).toBeGreaterThanOrEqual(1);

  expect(readText(sessionDir, PLAN_FILE).trim()).not.toBe('');

  EvidenceLedgerSchema.parse(readJson(sessionDir, EVIDENCE_FILE));
  expect(DriftReportSchema.parse(readJson(sessionDir, DRIFT_REPORT_FILE)).passed).toBe(true);

  const session = SessionSchema.parse(readJson(sessionDir, SUMMARY_FILE));
  if (session.status !== 'complete') {
    throw new Error(`${SUMMARY_FILE} status is '${session.status}', expected 'complete'`);
  }
  const summary = session.summary;
  expect(['pass', 'pass_with_notes']).toContain(summary.review?.verdict);
  expect(summary.totalTasks).toBe(tasks.length);
  expect(opts.completed, 'stdout `done:` count').toBe(summary.totalTasks);
  expect(summary.failed).toBe(0);
  expect(summary.completedByLocal).toBe(summary.totalTasks);
  expect(summary.escalatedToPlanner).toBe(0);
  const breakdown = summary.taskBreakdown ?? [];
  expect(breakdown.length).toBe(summary.totalTasks);
  for (const task of breakdown) {
    expect(task.method).toBe('local');
    expect(task.implementerTokens).toBeGreaterThan(0);
  }
  expect(summary.tokenUsage.reviewerInput).toBeGreaterThan(0);

  const events = readEventEntries(sessionDir);
  const calls = countRunnerCalls(events);
  expect(calls.planner).toBe(1);
  expect(calls.implementer).toBe(tasks.length);
  // The final review is two reviewer calls: the plan call that chooses the reviewer checks, then the verdict.
  expect(calls.review).toBe(2);
  expect(events.filter(wroteNothing)).toHaveLength(0);
  expect(events.filter((entry) => entry.type === 'runner_call_error')).toHaveLength(0);

  return { calls, perBrief: briefTimings(events), tasks };
}

export function assertFixtureQuality(projectDir: string): Promise<void> {
  return Promise.all(
    addEndpointScenario.qualityChecks.map(async (check) => {
      const result = await check.check(projectDir);
      expect(result.passed, `${check.name}: ${result.detail}`).toBe(true);
    }),
  ).then(() => undefined);
}

export function assertWorkingTree(projectDir: string, tasks: readonly Task[]): void {
  const declared = new Set(tasks.flatMap((task) => [...task.suggestedFiles]));
  // `-uall` so a brief that created the first file of a new directory is
  // reported as that file rather than as the collapsed `dir/` entry.
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectDir,
    encoding: 'utf-8',
  });
  for (const line of status.split('\n').filter((entry) => entry.trim() !== '')) {
    const file = porcelainPath(line);
    const allowed = declared.has(file) || file.startsWith(`${SPLITBRIEF_DIR}/`);
    expect(allowed, `working-tree change outside the declared set: ${file}`).toBe(true);
  }
}

function readText(sessionDir: string, file: string): string {
  return readFileSync(join(sessionDir, file), 'utf-8');
}

function readJson(sessionDir: string, file: string): unknown {
  return JSON.parse(readText(sessionDir, file));
}

export function readEventEntries(sessionDir: string): readonly SessionLogEventEntry[] {
  const entries: SessionLogEventEntry[] = [];
  for (const line of readText(sessionDir, SESSION_LOG_FILE).split('\n')) {
    if (line.trim() === '') continue;
    const parsed = SessionLogEventEntrySchema.safeParse(JSON.parse(line));
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

export function eventField(data: unknown, key: string): unknown {
  return isRecord(data) ? data[key] : undefined;
}

export function countRunnerCalls(events: readonly SessionLogEventEntry[]): RunnerCallCounts {
  let planner = 0;
  let implementer = 0;
  let review = 0;
  for (const entry of events) {
    if (entry.type !== 'runner_call_started') continue;
    const role = eventField(entry.data, 'role');
    // A planner-seat call outside the planning phases is an escalation or a
    // summary, and carries its own role; the planning session's one call counts
    // only the phases `phaseTokenRole` attributes to the planner.
    if (
      role === 'planner' &&
      entry.phase !== undefined &&
      phaseTokenRole(entry.phase) === 'planner'
    ) {
      planner += 1;
    }
    if (role === 'implementer') implementer += 1;
    if (role === 'review') review += 1;
  }
  return { planner, implementer, review };
}

function wroteNothing(entry: SessionLogEventEntry): boolean {
  return entry.type === 'warning' && eventField(entry.data, 'code') === 'implementer_wrote_nothing';
}

function briefTimings(events: readonly SessionLogEventEntry[]): readonly BriefTiming[] {
  const timings: BriefTiming[] = [];
  for (const entry of events) {
    if (entry.type !== 'task_completed' || entry.taskId === undefined) continue;
    const duration = eventField(entry.data, 'duration');
    if (typeof duration === 'number') timings.push({ id: entry.taskId, durationMs: duration });
  }
  return timings;
}

function porcelainPath(line: string): string {
  const entry = line.slice(3).trim();
  const renamed = entry.split(' -> ')[1];
  return (renamed ?? entry).replace(/^"|"$/g, '');
}
