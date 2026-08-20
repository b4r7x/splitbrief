import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CliExecutableReceipt } from '../../../core/discovery/detection.js';
import { CliExecutableReceiptSchema } from '../../../core/discovery/detection.js';
import { ConfigSchema, type Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ImplementerResult } from '../../implementers/types.js';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  type ChangedFilesBaseline,
} from '../../orchestrator/changed-files-baseline.js';
import { createImplementer, createPlanner } from '../factory.js';
import type { RunnerGate } from '../prepared-execution.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  safeReason,
  writeEvidenceFile,
  type CliConformanceExitCode,
  type CliConformanceOutcome,
  type CliConformanceRole,
} from './contract-harness.js';

/**
 * The exact effect one role must prove against the staged project (REQ-015,
 * REQ-048). A planner effect is immutability; a direct-write implementer
 * effect is the nonce-bearing content at the exact declared staged source
 * path and nothing else.
 */
export type CliEffectDeclaration =
  | Readonly<{ kind: 'planner-read-only' }>
  | Readonly<{ kind: 'direct-write'; file: string; nonceContent: string }>;

export type FactoryEffectConformanceOptions = Readonly<{
  role: CliConformanceRole;
  projectDir: string;
  prompt: string;
  executable: CliExecutableReceipt;
  effect: CliEffectDeclaration;
  recordPath: string;
  /** Required for the implementer role; the declared staged source path is `task.file`. */
  task?: Task | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}>;

const EFFECT_CANDIDATE_ID = 'opencode' as const;

function effectOutcome(
  exitCode: CliConformanceExitCode,
  role: CliConformanceRole,
  reason?: string,
): CliConformanceOutcome {
  return {
    exitCode,
    verdict: exitCode === CLI_CONFORMANCE_EXIT_CODES.PASS ? 'PASS' : 'OMIT',
    candidateId: EFFECT_CANDIDATE_ID,
    role,
    ...(reason !== undefined && { reason }),
  };
}

function effectConfig(timeoutMs: number | undefined): Config {
  return ConfigSchema.parse({
    version: 3,
    planner: {
      kind: 'cli',
      tool: EFFECT_CANDIDATE_ID,
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    },
    implementer: {
      kind: 'cli',
      tool: EFFECT_CANDIDATE_ID,
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    },
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: {
      maxRetries: 0,
      persistTranscript: false,
      mode: 'instant',
      taskReview: 'none',
      compactionFormat: 'auto',
    },
  });
}

function normalizeEffectFile(file: string): string {
  return file.replace(/^\.\//, '');
}

async function writeEffectRecord(
  options: FactoryEffectConformanceOptions,
  outcome: CliConformanceOutcome,
  changed: readonly string[],
): Promise<void> {
  await writeEvidenceFile(
    options.recordPath,
    JSON.stringify(
      {
        candidateId: EFFECT_CANDIDATE_ID,
        role: options.role,
        verdict: outcome.verdict,
        exitCode: outcome.exitCode,
        ...(outcome.reason !== undefined && { reason: outcome.reason }),
        changedFiles: changed.slice(0, 64),
      },
      null,
      2,
    ),
  );
}

function verifyPlannerImmutability(changed: readonly string[]): CliConformanceOutcome {
  return changed.length === 0
    ? effectOutcome(CLI_CONFORMANCE_EXIT_CODES.PASS, 'planner')
    : effectOutcome(
        CLI_CONFORMANCE_EXIT_CODES.OMIT,
        'planner',
        `planner mutated the staged project: ${changed.join(', ')}`,
      );
}

async function verifyImplementerEffect(
  options: FactoryEffectConformanceOptions,
  result: ImplementerResult,
  changed: readonly string[],
): Promise<CliConformanceOutcome> {
  if (options.effect.kind !== 'direct-write') {
    return effectOutcome(
      CLI_CONFORMANCE_EXIT_CODES.OMIT,
      'implementer',
      'implementer effect must declare a direct-write target',
    );
  }
  if (!result.success) {
    return effectOutcome(
      CLI_CONFORMANCE_EXIT_CODES.OMIT,
      'implementer',
      result.error ?? 'implementer call did not complete',
    );
  }
  const declared = normalizeEffectFile(options.effect.file);
  const exact = changed.length === 1 && changed[0] === declared;
  if (!exact) {
    const reason =
      changed.length === 0
        ? 'implementer produced no staged-project change'
        : `implementer changed ${changed.join(', ')} instead of exactly ${declared}`;
    return effectOutcome(CLI_CONFORMANCE_EXIT_CODES.OMIT, 'implementer', reason);
  }
  const content = await readFile(resolve(options.projectDir, declared), 'utf8');
  if (content !== options.effect.nonceContent) {
    return effectOutcome(
      CLI_CONFORMANCE_EXIT_CODES.OMIT,
      'implementer',
      'implementer wrote content that does not match the declared nonce',
    );
  }
  return effectOutcome(CLI_CONFORMANCE_EXIT_CODES.PASS, 'implementer');
}

function failureEffectOutcome(
  options: FactoryEffectConformanceOptions,
  changed: readonly string[],
  cause: unknown,
): CliConformanceOutcome {
  if (changed.length > 0) {
    return effectOutcome(
      CLI_CONFORMANCE_EXIT_CODES.OMIT,
      options.role,
      `${options.role} mutated the staged project: ${changed.join(', ')}`,
    );
  }
  if (options.signal?.aborted) {
    return effectOutcome(CLI_CONFORMANCE_EXIT_CODES.OMIT, options.role, 'invocation was aborted');
  }
  return effectOutcome(CLI_CONFORMANCE_EXIT_CODES.OMIT, options.role, safeReason(cause));
}

async function runPlannerEffect(
  options: FactoryEffectConformanceOptions,
  config: Config,
  executable: CliExecutableReceipt,
): Promise<void> {
  const slot = { role: 'planner' } as const;
  const preparationId = 'effect-conformance-planner';
  const gates: readonly RunnerGate[] = [
    { kind: 'cli', slot, preparationId, tool: EFFECT_CANDIDATE_ID, executable },
  ];
  const planner = await createPlanner(config, {
    preparedConfig: config,
    projectDir: options.projectDir,
    preparationId,
    gates,
    slot,
    initialSessionId: null,
  });
  await planner.review(options.prompt, options.projectDir, {
    onOutput: () => {},
    signal: options.signal,
  });
}

async function runImplementerEffect(
  options: FactoryEffectConformanceOptions,
  config: Config,
  executable: CliExecutableReceipt,
  task: Task,
): Promise<ImplementerResult> {
  const slot = { role: 'implementer', profile: 'default' } as const;
  const preparationId = 'effect-conformance-implementer';
  const gates: readonly RunnerGate[] = [
    { kind: 'cli', slot, preparationId, tool: EFFECT_CANDIDATE_ID, executable },
  ];
  const implementer = await createImplementer(config, {
    preparedConfig: config,
    preparationId,
    gates,
    slot,
  });
  return implementer.implement({
    task,
    projectDir: options.projectDir,
    config,
    context: { name: 'effect-conformance', dir: options.projectDir },
    onOutput: () => {},
    signal: options.signal,
    changeDetection: 'git-status',
  });
}

/**
 * Drives the production factory (`createPlanner` / `createImplementer`) against
 * a staged git project and proves the declared effect. The planner entry is
 * the read-only review path whose production mutation guard throws on any
 * staged change; the implementer entry is the direct-write pipeline, and the
 * harness independently verifies that exactly the declared nonce-bearing
 * change landed at exactly the declared staged source path. Any deviation —
 * mutation, no-op, wrong target, wrong content, extra change, fallback to a
 * read-only posture, or a non-completing terminal outcome — is an OMIT with
 * the observed reason, and the observed effect is recorded at `recordPath`.
 */
export async function runFactoryEffectConformance(
  options: FactoryEffectConformanceOptions,
): Promise<CliConformanceOutcome> {
  const receipt = CliExecutableReceiptSchema.safeParse(options.executable);
  if (!receipt.success) {
    const outcome = effectOutcome(
      CLI_CONFORMANCE_EXIT_CODES.OMIT,
      options.role,
      'invalid executable receipt',
    );
    await writeEffectRecord(options, outcome, []);
    return outcome;
  }
  const config = effectConfig(options.timeoutMs);
  const baseline: ChangedFilesBaseline = await captureChangedFilesBaseline(options.projectDir);
  let changed: readonly string[] = [];
  let outcome: CliConformanceOutcome;
  try {
    if (options.role === 'planner') {
      await runPlannerEffect(options, config, receipt.data);
      changed = await changedFilesSinceBaseline(options.projectDir, baseline);
      outcome = verifyPlannerImmutability(changed);
    } else if (options.task === undefined) {
      outcome = effectOutcome(
        CLI_CONFORMANCE_EXIT_CODES.OMIT,
        'implementer',
        'implementer effect requires a task',
      );
    } else {
      const result = await runImplementerEffect(options, config, receipt.data, options.task);
      changed = await changedFilesSinceBaseline(options.projectDir, baseline);
      outcome = await verifyImplementerEffect(options, result, changed);
    }
  } catch (cause) {
    changed = await changedFilesSinceBaseline(options.projectDir, baseline);
    outcome = failureEffectOutcome(options, changed, cause);
  }
  await writeEffectRecord(options, outcome, changed);
  return outcome;
}
