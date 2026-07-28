import {
  CLI_TOOL_IDS,
  RUNNER_KINDS,
  KNOWN_API_PROVIDERS,
  type ApproveLevel,
  type RunnerKind,
} from '../../schemas/enums.js';
import { getRunnerKindMeta } from '../../schemas/runner-fields.js';
import { resolveDefaultApiBase } from '../../providers/catalog.js';
import { narrowRecord, includes } from '../../../utils/type-guards.js';
import { configError } from '../errors.js';
import { ConfigSchema } from '../../schemas/config.js';
import { inferKindFromTool } from '../runtime/build-runner.js';

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
    return reconcileLegacyCommitStrategy(obj);
  } else if (version === 2) {
    v2 = obj;
    warnings?.push(
      'config.version 2 is deprecated; SPLITBRIEF migrated it in memory. Run `splitbrief init --reconfigure` to write a current config.',
    );
  } else {
    if (version === undefined) {
      warnings?.push(
        'config.version is missing; SPLITBRIEF assumed version 1 and migrated it in memory, which drops fields added after v1. Run `splitbrief init --reconfigure` to write a current config.',
      );
    }
    v2 = narrowRecord(migrateV1ToV2(obj)) ?? {};
  }

  return migrateV2ToV3(v2);
}

export function migrateV2ToV3(v2: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...v2, version: 3 };

  const workflow = narrowRecord(v2.workflow);
  if (workflow) {
    const newWorkflow: Record<string, unknown> = { ...workflow };

    const autoSpec = workflow.autoApproveSpec === true;
    const autoPlan = workflow.autoApprovePlan === true;
    if (newWorkflow.approve === undefined) {
      newWorkflow.approve = deriveApproveLevel({
        autoApproveSpec: autoSpec,
        autoApprovePlan: autoPlan,
      });
    }

    foldCommitStrategyIntoGit(workflow, newWorkflow);

    if (typeof workflow.mode === 'string' && workflow.mode === 'full') {
      newWorkflow.mode = 'speckit';
    }

    result.workflow = newWorkflow;
  }

  return result;
}

function foldCommitStrategyIntoGit(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  const topCommit = source.commitStrategy;
  const existingGit = narrowRecord(source.git);
  if (topCommit === undefined && !existingGit) return;
  const git: Record<string, unknown> = { ...(existingGit ?? {}) };
  if (git.commitStrategy === undefined && topCommit !== undefined) {
    git.commitStrategy = topCommit;
  }
  target.git = git;
}

function reconcileLegacyCommitStrategy(obj: Record<string, unknown>): Record<string, unknown> {
  const workflow = narrowRecord(obj.workflow);
  if (!workflow || workflow.commitStrategy === undefined) return obj;
  const newWorkflow: Record<string, unknown> = { ...workflow };
  foldCommitStrategyIntoGit(workflow, newWorkflow);
  return { ...obj, workflow: newWorkflow };
}

interface DeriveApproveLevelInput {
  autoApproveSpec?: boolean;
  autoApprovePlan?: boolean;
}

function deriveApproveLevel(flags: DeriveApproveLevelInput): ApproveLevel {
  const spec = flags.autoApproveSpec === true;
  const plan = flags.autoApprovePlan === true;
  if (spec && plan) return 'none';
  if (spec) return 'plan';
  if (plan) return 'spec';
  return 'default';
}

const V1_SPECIAL_KEYS = new Set(['version', 'planner', 'implementer', 'workflow']);

function migrateV1ToV2(obj: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = {
    version: 2,
    planner: obj.planner ? migrateRunnerV1ToV2('planner', obj.planner) : undefined,
    implementer: obj.implementer ? migrateRunnerV1ToV2('implementer', obj.implementer) : undefined,
    workflow: migrateWorkflowV1ToV2(obj.workflow),
  };
  for (const key of Object.keys(ConfigSchema.shape)) {
    if (V1_SPECIAL_KEYS.has(key)) continue;
    if (key in obj) result[key] = obj[key];
  }
  return result;
}

function migrateWorkflowV1ToV2(raw: unknown): unknown {
  const workflow = narrowRecord(raw);
  if (!workflow) return undefined;

  const result = { ...workflow };

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

  const kind = inferLegacyKind({ legacyKind, tool, command, apiBase, role });

  if (kind === 'cli') {
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

interface LegacyKindInput {
  legacyKind?: string | undefined;
  tool?: string | undefined;
  command?: string | undefined;
  apiBase?: string | undefined;
  role: 'planner' | 'implementer';
}

function inferLegacyKind(input: LegacyKindInput): RunnerKind {
  const { legacyKind, tool, command, apiBase, role } = input;
  if (legacyKind && includes(RUNNER_KINDS, legacyKind)) {
    return legacyKind;
  }

  if (legacyKind && includes(CLI_TOOL_IDS, legacyKind)) {
    return 'cli';
  }

  if (tool && inferKindFromTool(tool) === 'cli') return 'cli';
  if (apiBase) return 'api';
  if (command) return 'shell';

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
