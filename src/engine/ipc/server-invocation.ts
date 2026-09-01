import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configError } from '../../core/config/errors.js';
import type { CLIOverrides } from '../../core/config/runtime/overrides/schema.js';
import {
  APPROVE_LEVELS,
  EFFORT_LEVELS,
  WORKFLOW_MODES,
  normalizeWorkflowMode,
  type ApproveLevel,
  type EffortLevel,
  type WorkflowMode,
} from '../../core/schemas/enums.js';
import type { SessionOwnershipReceipt } from '../../core/sessions/active-pointer.js';
import { readOtelExporterFromArgv } from '../../lib/otel.js';
import { error } from '../../utils/error.js';
import type { IpcServerArgs } from './server-args.js';

export type SpawnServerOptions = {
  candidate: SessionOwnershipReceipt;
  projectDir: string;
  feature: string;
  overrides?: CLIOverrides;
  allowHooks?: boolean;
  allowRepoRunners?: boolean;
  allowUnverifiedAuth?: boolean;
  plannerContext?: string;
  attachments?: Array<{ id: string; path: string; mimeType: string }>;
  signal?: AbortSignal | undefined;
};

export const serverInvocationError = {
  unsupportedOverrides: (flags: readonly string[]) =>
    error(
      'detached-overrides-not-transportable',
      `Detached start does not support ${flags.join(', ')} because those values cannot cross the process boundary safely.`,
      { flags },
    ),
} as const;

export function resolveEntryPoint(
  moduleDir: string = import.meta.dirname,
  moduleFile: string = import.meta.filename,
): {
  command: string;
  args: string[];
  tsx: boolean;
} {
  const packageRoot = join(moduleDir, '..', '..', '..');
  const runningUnderTsx = moduleFile.endsWith('.ts');

  if (runningUnderTsx) {
    const srcEntry = join(packageRoot, 'src', 'engine', 'ipc', 'server-entry.ts');
    return { command: 'npx', args: ['tsx', srcEntry], tsx: true };
  }

  const distEntry = join(packageRoot, 'dist', 'engine', 'ipc', 'server-entry.js');
  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry], tsx: false };
  }

  const srcEntry = join(packageRoot, 'src', 'engine', 'ipc', 'server-entry.ts');
  return { command: 'npx', args: ['tsx', srcEntry], tsx: true };
}

export function buildServerArgv(entryArgs: string[], argsFile: string): string[] {
  return [...entryArgs, argsFile];
}

function transportableMode(mode: string): WorkflowMode {
  const normalized = normalizeWorkflowMode(mode);
  if (normalized === undefined) {
    throw configError.invalidOverride('mode', mode, `Must be one of: ${WORKFLOW_MODES.join(', ')}`);
  }
  return normalized;
}

function transportableLevel<T extends string>(field: string, raw: string, levels: readonly T[]): T {
  const match = levels.find((level) => level === raw);
  if (match === undefined) {
    throw configError.invalidOverride(field, raw, `Must be one of: ${levels.join(', ')}`);
  }
  return match;
}

export function assertDetachedOverridesTransportable(
  input: Readonly<{
    overrides?: CLIOverrides | undefined;
  }>,
): void {
  const flags: string[] = [];
  if ((input.overrides?.planner?.args?.length ?? 0) > 0) flags.push('--planner-args');
  if ((input.overrides?.implementer?.args?.length ?? 0) > 0) flags.push('--implementer-args');
  if ((input.overrides?.reviewer?.args?.length ?? 0) > 0) flags.push('--reviewer-args');
  if (input.overrides?.planner?.apiKey !== undefined) flags.push('--planner-api-key-env');
  if (input.overrides?.implementer?.apiKey !== undefined) flags.push('--implementer-api-key-env');
  if (input.overrides?.reviewer?.apiKey !== undefined) flags.push('--reviewer-api-key-env');
  if (flags.length > 0) throw serverInvocationError.unsupportedOverrides(flags);
}

// The owner-only, one-shot bootstrap is the detached child's only channel for planner input.
// It carries raw feature text while resolved config, runner gates, and explicit API keys remain
// process-local; consumer-facing persistence is redacted later from the child's prepared config.
export function buildServerArgs(opts: SpawnServerOptions): IpcServerArgs {
  assertDetachedOverridesTransportable({ overrides: opts.overrides });
  const { apiKey: _plannerApiKey, args: _plannerArgs, ...planner } = opts.overrides?.planner ?? {};
  const {
    apiKey: _implementerApiKey,
    args: _implementerArgs,
    ...implementer
  } = opts.overrides?.implementer ?? {};
  const {
    apiKey: _reviewerApiKey,
    args: _reviewerArgs,
    ...reviewer
  } = opts.overrides?.reviewer ?? {};
  const {
    mode: rawMode,
    approve: rawApprove,
    plannerEffort: rawPlannerEffort,
    reviewerEffort: rawReviewerEffort,
    ...transportable
  } = opts.overrides ?? {};
  const overrides = {
    ...transportable,
    ...(rawMode !== undefined && { mode: transportableMode(rawMode) }),
    ...(rawApprove !== undefined && {
      approve: transportableLevel<ApproveLevel>('approve', rawApprove, APPROVE_LEVELS),
    }),
    ...(rawPlannerEffort !== undefined && {
      plannerEffort: transportableLevel<EffortLevel>(
        'plannerEffort',
        rawPlannerEffort,
        EFFORT_LEVELS,
      ),
    }),
    ...(rawReviewerEffort !== undefined && {
      reviewerEffort: transportableLevel<EffortLevel>(
        'reviewerEffort',
        rawReviewerEffort,
        EFFORT_LEVELS,
      ),
    }),
    ...(opts.overrides?.planner !== undefined && { planner }),
    ...(opts.overrides?.implementer !== undefined && { implementer }),
    ...(opts.overrides?.reviewer !== undefined && { reviewer }),
  };
  return {
    version: 1,
    parentPid: process.pid,
    candidate: opts.candidate,
    projectDir: opts.projectDir,
    feature: opts.feature,
    overrides,
    ...(opts.allowHooks !== undefined && { allowHooks: opts.allowHooks }),
    ...(opts.allowRepoRunners !== undefined && { allowRepoRunners: opts.allowRepoRunners }),
    ...(opts.allowUnverifiedAuth !== undefined && {
      allowUnverifiedAuth: opts.allowUnverifiedAuth,
    }),
    ...(opts.plannerContext !== undefined && { plannerContext: opts.plannerContext }),
    ...(opts.attachments !== undefined && { attachments: opts.attachments }),
  };
}

// The detached child inherits process.env, so OTEL_TRACES_EXPORTER / SPLITBRIEF_OTEL_EXPORTER
// already propagate. The `--otel-exporter` CLI flag lives only in the parent's argv, so it
// must be translated into an env var the child's bootstrapOtel() can read.
export function buildServerEnv(): NodeJS.ProcessEnv {
  const exporter = readOtelExporterFromArgv(process.argv);
  if (exporter === undefined) return process.env;
  return { ...process.env, SPLITBRIEF_OTEL_EXPORTER: exporter };
}
