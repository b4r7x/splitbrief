import { CLI_TOOL_IDS, RUNNER_KINDS, KNOWN_API_PROVIDERS, type ApproveLevel } from '../../schemas/enums.js';
import { getRunnerKindMeta } from '../../schemas/runner-fields.js';
import { resolveDefaultApiBase } from '../../providers/catalog.js';
import { narrowRecord, includes } from '../../../utils/type-guards.js';
import { configError } from '../errors.js';
import type { RunnerKind } from '../../schemas/enums.js';

/**
 * Migrate a raw config blob through v1 → v2 → v3 in sequence. Returns the
 * fully-migrated v3 shape. Optional `warnings` array collects deprecation
 * notices produced during migration (e.g. from v2 to v3 of a config still
 * declaring `version: 2`).
 *
 * The returned config preserves deprecated v2 workflow keys
 * (`autoApproveSpec`, `autoApprovePlan`, top-level `commitStrategy`) alongside
 * their v3 replacements (`approve`, `git.commitStrategy`). Briefs 04 and 07
 * remove the v2 read sites; until then dual-population keeps existing readers
 * working.
 */
export function migrateConfig(raw: unknown, warnings?: string[]): unknown {
  if (!raw || typeof raw !== 'object') {
    throw configError.notAnObject('Config');
  }

  const obj = narrowRecord(raw);
  if (!obj) throw configError.notAnObject('Config');
  const version = typeof obj.version === 'number' ? obj.version : undefined;

  if (version !== undefined && version !== 1 && version !== 2 && version !== 3) {
    throw configError.unsupportedVersion(version);
  }

  let v2: Record<string, unknown>;
  if (version === 3) {
    return raw;
  } else if (version === 2) {
    v2 = obj;
    warnings?.push("config.version 2 is deprecated; upgrade to 3 (run `diptych migrate` or rerun `diptych init`).");
  } else {
    v2 = narrowRecord(migrateV1ToV2(obj)) ?? {};
  }

  return migrateV2ToV3(v2);
}

/**
 * Migrate a v2 config to v3:
 *  - bumps `version` to 3
 *  - introduces `workflow.approve` derived from v2 auto-approve flags
 *  - moves `workflow.commitStrategy` into `workflow.git.commitStrategy`
 *  - normalizes legacy `workflow.mode = 'full'` to `'speckit'`
 *  - preserves deprecated v2 keys for backward-compat reads
 */
export function migrateV2ToV3(v2: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...v2, version: 3 };

  const workflow = narrowRecord(v2.workflow);
  if (workflow) {
    const newWorkflow: Record<string, unknown> = { ...workflow };

    const autoSpec = workflow.autoApproveSpec === true;
    const autoPlan = workflow.autoApprovePlan === true;
    if (newWorkflow.approve === undefined) {
      newWorkflow.approve = deriveApproveLevel({ autoApproveSpec: autoSpec, autoApprovePlan: autoPlan });
    }

    const topCommit = workflow.commitStrategy;
    const existingGit = narrowRecord(workflow.git);
    if (topCommit !== undefined || existingGit) {
      const git: Record<string, unknown> = { ...(existingGit ?? {}) };
      if (git.commitStrategy === undefined && topCommit !== undefined) {
        git.commitStrategy = topCommit;
      }
      newWorkflow.git = git;
    }

    if (typeof workflow.mode === 'string' && workflow.mode === 'full') {
      newWorkflow.mode = 'speckit';
    }

    result.workflow = newWorkflow;
  }

  return result;
}

export interface DeriveApproveLevelInput {
  autoApproveSpec?: boolean;
  autoApprovePlan?: boolean;
}

/**
 * Derive the v3 `workflow.approve` level from v2 auto-approve flags.
 *
 *  - both true   → 'none'   (no manual gates)
 *  - spec true   → 'plan'   (gate at plan)
 *  - plan true   → 'spec'   (gate at spec)
 *  - both false  → 'default' (preserve mode-defined gates)
 */
export function deriveApproveLevel(flags: DeriveApproveLevelInput): ApproveLevel {
  const spec = flags.autoApproveSpec === true;
  const plan = flags.autoApprovePlan === true;
  if (spec && plan) return 'none';
  if (spec) return 'plan';
  if (plan) return 'spec';
  return 'default';
}

function migrateV1ToV2(obj: Record<string, unknown>): unknown {
  return {
    version: 2,
    planner: obj.planner ? migrateRunnerV1ToV2('planner', obj.planner) : undefined,
    implementer: obj.implementer ? migrateRunnerV1ToV2('implementer', obj.implementer) : undefined,
    validation: obj.validation,
    workflow: migrateWorkflowV1ToV2(obj.workflow),
    theme: obj.theme,
    shikiTheme: obj.shikiTheme,
    sessions: obj.sessions,
    escalation: obj.escalation,
    codebase: obj.codebase,
    hooks: obj.hooks,
    otel: obj.otel,
    snapshots: obj.snapshots,
    palette: obj.palette,
    approval: obj.approval,
    implementerProfiles: obj.implementerProfiles,
    plannerEstimateReview: obj.plannerEstimateReview,
    autoSplitOverflow: obj.autoSplitOverflow,
  };
}

function migrateWorkflowV1ToV2(raw: unknown): unknown {
  const workflow = narrowRecord(raw);
  if (!workflow) return undefined;

  const result = { ...workflow };

  // Migrate commitPerTask → commitStrategy
  if ('commitPerTask' in result) {
    const commitPerTask = result.commitPerTask;
    delete result.commitPerTask;
    if (result.commitStrategy === undefined) {
      result.commitStrategy = commitPerTask ? 'per-task' : 'none';
    }
  }

  return result;
}

function migrateRunnerV1ToV2(role: 'planner' | 'implementer', raw: unknown): unknown {
  const runner = narrowRecord(raw);
  if (!runner) {
    throw configError.notAnObject(`${role} config`);
  }

  const legacyKind = typeof runner.kind === 'string' ? runner.kind : undefined;
  const tool = typeof runner.tool === 'string' ? runner.tool : undefined;
  const command = typeof runner.command === 'string' ? runner.command : undefined;
  const apiBase = typeof runner.apiBase === 'string' ? runner.apiBase : undefined;

  // Infer the new kind
  const kind = inferLegacyKind(legacyKind, tool, command, apiBase, role);

  // cli and api have unique migration logic
  if (kind === 'cli') {
    // Planners with no explicit tool/kind default to claude-code
    const resolvedTool = tool || legacyKind || (role === 'planner' ? 'claude-code' : undefined);
    return {
      kind: 'cli',
      tool: resolvedTool,
      ...pickCommonFields(runner),
      ...pickArgsOutputFormat(runner),
    };
  }

  if (kind === 'api') {
    const providerField = typeof runner.provider === 'string' ? runner.provider : undefined;
    const provider = providerField || tool || (role === 'implementer' ? 'ollama' : 'anthropic');

    const resolvedApiBase = apiBase || resolveDefaultApiBase(provider);
    if (!resolvedApiBase) {
      throw configError.unknownProvider(provider, KNOWN_API_PROVIDERS, role);
    }

    const apiKeyValue = typeof runner.apiKey === 'string' ? runner.apiKey : undefined;
    return {
      kind: 'api',
      provider,
      apiBase: resolvedApiBase,
      ...(apiKeyValue && { apiKey: apiKeyValue }),
      ...pickCommonFields(runner),
    };
  }

  // All other kinds are descriptor-driven
  const meta = getRunnerKindMeta(kind);

  if (meta.requiresCommand && !command) {
    throw configError.runnerMissingField(role, kind, 'command');
  }

  const result: Record<string, unknown> = { kind };
  if (meta.requiresCommand) result.command = command;
  if (meta.usesApiKey) {
    const apiKeyValue = typeof runner.apiKey === 'string' ? runner.apiKey : undefined;
    if (apiKeyValue) result.apiKey = apiKeyValue;
  }
  Object.assign(result, pickCommonFields(runner));
  if (meta.usesArgsOutputFormat) Object.assign(result, pickArgsOutputFormat(runner));
  return result;
}

function inferLegacyKind(
  legacyKind: string | undefined,
  tool: string | undefined,
  command: string | undefined,
  apiBase: string | undefined,
  role: 'planner' | 'implementer',
): RunnerKind {
  // New v2 kinds pass through
  if (legacyKind && includes(RUNNER_KINDS, legacyKind)) {
    return legacyKind;
  }

  // Legacy CLI-tool-as-kind (e.g., kind: 'claude-code')
  if (legacyKind && includes(CLI_TOOL_IDS, legacyKind)) {
    return 'cli';
  }

  // Infer from shape
  if (tool && includes(CLI_TOOL_IDS, tool)) return 'cli';
  if (apiBase) return 'api';
  if (command) return 'shell';

  // Default: planners fall back to cli (claude-code); implementers fall back to api (ollama)
  return role === 'planner' ? 'cli' : 'api';
}

function pickCommonFields(runner: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (runner.model) result.model = runner.model;
  if (runner.customModels) result.customModels = runner.customModels;
  if (runner.contextLength) result.contextLength = runner.contextLength;
  if (runner.temperature !== undefined) result.temperature = runner.temperature;
  if (runner.timeout) result.timeout = runner.timeout;
  return result;
}

function pickArgsOutputFormat(runner: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (runner.args) result.args = runner.args;
  if (runner.outputFormat) result.outputFormat = runner.outputFormat;
  return result;
}
