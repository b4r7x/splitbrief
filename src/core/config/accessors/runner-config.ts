import { parseApiKeyEnvRef } from '../credentials.js';
import { readActiveRunnerLens } from './active-runner.js';
import { resolveCliModel } from '../../providers/automatic-model.js';
import { resolveAutoModel } from '../../providers/model-selection.js';
import { getProviderDisplayName } from '../../providers/catalog.js';
import { API_PROVIDER_CATALOG } from '../../providers/api-provider-catalog.js';
import { isPlannerToolId, type PlannerToolId } from '../../schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { Config } from '../../schemas/config.js';
import type { ActiveRunnerConfig } from './active-runner.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';
import {
  defaultCliAuthChannel,
  runnerRoleForActiveRole,
  type ActiveRunnerRole,
  type CliAuthChannelId,
  type RunnerRole,
} from '../../runners/cli-tool-catalog.js';

export type RunnerConfig = ActiveRunnerConfig;

export type DeepReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

export type RunnerConfigSlot =
  | Readonly<{ role: 'planner' }>
  | Readonly<{ role: 'implementer'; profile: string }>
  | Readonly<{ role: 'intermediate' }>
  | Readonly<{ role: 'reviewer' }>;

export type RunnerConfigSource =
  | Readonly<{ role: 'planner'; runner: DeepReadonly<PlannerConfig> }>
  | Readonly<{
      role: 'implementer';
      profile: string;
      runner: DeepReadonly<ImplementerConfig>;
    }>
  | Readonly<{ role: 'intermediate'; runner: DeepReadonly<ImplementerConfig> }>
  | Readonly<{ role: 'reviewer'; runner: DeepReadonly<ReviewerConfig> }>;

export type RunnerConfigContext = Readonly<{
  slot: RunnerConfigSlot;
  runner: DeepReadonly<RunnerConfig>;
}>;

export type CredentialSourceIdentity =
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'inline'; readonly configNodeId: string };

export interface CredentialDomainIdentity {
  readonly providerId: string;
  readonly endpointOrigin: string;
  readonly authChannel: 'api-key';
  readonly credentialSource: CredentialSourceIdentity;
  readonly configGeneration: string;
}

export interface RunnerDiscoveryContext {
  readonly role: RunnerRole;
  readonly kind: RunnerConfig['kind'];
  readonly id: string;
  readonly model?: string | undefined;
  readonly authChannel?: CliAuthChannelId | undefined;
  readonly endpointOrigin?: string | undefined;
  readonly credentialPresent: boolean;
  readonly credentialDomain?: CredentialDomainIdentity | undefined;
  readonly configGeneration: string;
}

export interface ProjectRunnerDiscoveryContextInput {
  readonly config: Config;
  readonly role: ActiveRunnerRole;
}

const configGenerations = new WeakMap<object, string>();
let nextOpaqueIdentity = 1;

function opaqueIdentity(store: WeakMap<object, string>, value: object, prefix: string): string {
  const existing = store.get(value);
  if (existing !== undefined) return existing;

  const identity = `${prefix}-${nextOpaqueIdentity}`;
  nextOpaqueIdentity += 1;
  store.set(value, identity);
  return identity;
}

function endpointOrigin(apiBase: string): string {
  return new URL(apiBase).origin;
}

export function resolveRunnerConfigContext(source: RunnerConfigSource): RunnerConfigContext {
  switch (source.role) {
    case 'planner':
      return { slot: { role: 'planner' }, runner: source.runner };
    case 'implementer':
      return {
        slot: { role: 'implementer', profile: source.profile },
        runner: source.runner,
      };
    case 'intermediate':
      return { slot: { role: 'intermediate' }, runner: source.runner };
    case 'reviewer':
      return { slot: { role: 'reviewer' }, runner: source.runner };
    default:
      return assertNever(source);
  }
}

export function runnerRoleForSlot(slot: RunnerConfigSlot): RunnerRole {
  return slot.role === 'intermediate' ? 'implementer' : runnerRoleForActiveRole(slot.role);
}

function anthropicEndpointOrigin(): string | undefined {
  const policy = API_PROVIDER_CATALOG.anthropic.endpointPolicy;
  switch (policy.kind) {
    case 'fixed-origin':
      return endpointOrigin(policy.baseURL);
    case 'loopback':
      return endpointOrigin(policy.defaultBaseURL);
    case 'allowed-https':
      return undefined;
  }
}

function runnerId(runner: RunnerConfig): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    case 'shell':
    case 'agent':
    case 'agent-sdk':
      return runner.kind;
    default:
      return assertNever(runner);
  }
}

function credentialSource(
  apiKey: string | undefined,
  sourceNodeId: string,
): CredentialSourceIdentity | undefined {
  if (apiKey === undefined || apiKey.length === 0) return undefined;

  const envRef = parseApiKeyEnvRef(apiKey);
  if (envRef !== undefined) return { kind: 'env', name: envRef };

  return {
    kind: 'inline',
    configNodeId: sourceNodeId,
  };
}

function apiCredentialDomain({
  runner,
  sourceNodeId,
  configGeneration,
}: Readonly<{
  runner: Extract<RunnerConfig, { kind: 'api' }>;
  sourceNodeId: string;
  configGeneration: string;
}>): CredentialDomainIdentity | undefined {
  const source = credentialSource(runner.apiKey, sourceNodeId);
  if (source === undefined) return undefined;

  return {
    providerId: runner.provider,
    endpointOrigin: endpointOrigin(runner.apiBase),
    authChannel: 'api-key',
    credentialSource: source,
    configGeneration,
  };
}

function agentSdkCredentialDomain({
  runner,
  sourceNodeId,
  configGeneration,
}: Readonly<{
  runner: Extract<RunnerConfig, { kind: 'agent-sdk' }>;
  sourceNodeId: string;
  configGeneration: string;
}>): CredentialDomainIdentity | undefined {
  const source = credentialSource(runner.apiKey, sourceNodeId);
  const origin = anthropicEndpointOrigin();
  if (source === undefined || origin === undefined) return undefined;

  return {
    providerId: 'anthropic',
    endpointOrigin: origin,
    authChannel: 'api-key',
    credentialSource: source,
    configGeneration,
  };
}

function credentialDomain({
  runner,
  sourceNodeId,
  configGeneration,
}: Readonly<{
  runner: RunnerConfig;
  sourceNodeId: string;
  configGeneration: string;
}>): CredentialDomainIdentity | undefined {
  switch (runner.kind) {
    case 'api':
      return apiCredentialDomain({ runner, sourceNodeId, configGeneration });
    case 'agent-sdk':
      return agentSdkCredentialDomain({ runner, sourceNodeId, configGeneration });
    case 'cli':
    case 'shell':
    case 'agent':
      return undefined;
    default:
      return assertNever(runner);
  }
}

function contextAuthChannel(runner: RunnerConfig): CliAuthChannelId | undefined {
  if (runner.kind === 'cli') return runner.authChannel ?? defaultCliAuthChannel(runner.tool).id;
  if (runner.kind === 'api' || runner.kind === 'agent-sdk') return 'api-key';
  return undefined;
}

function contextEndpointOrigin(runner: RunnerConfig): string | undefined {
  if (runner.kind === 'api') return endpointOrigin(runner.apiBase);
  if (runner.kind === 'agent-sdk') return anthropicEndpointOrigin();
  return undefined;
}

export function isSameCredentialDomain({
  left,
  right,
}: Readonly<{
  left: CredentialDomainIdentity | undefined;
  right: CredentialDomainIdentity | undefined;
}>): boolean {
  if (left === undefined || right === undefined) return false;
  if (
    left.providerId !== right.providerId ||
    left.endpointOrigin !== right.endpointOrigin ||
    left.authChannel !== right.authChannel ||
    left.configGeneration !== right.configGeneration ||
    left.credentialSource.kind !== right.credentialSource.kind
  ) {
    return false;
  }

  if (left.credentialSource.kind === 'env' && right.credentialSource.kind === 'env') {
    return left.credentialSource.name === right.credentialSource.name;
  }

  if (left.credentialSource.kind === 'inline' && right.credentialSource.kind === 'inline') {
    return left.credentialSource.configNodeId === right.credentialSource.configNodeId;
  }

  return false;
}

export function projectRunnerDiscoveryContext(
  input: ProjectRunnerDiscoveryContextInput,
): RunnerDiscoveryContext {
  const activeRunner = readActiveRunnerLens(input);
  const runner = activeRunner.runner;
  const configGeneration = opaqueIdentity(configGenerations, input.config, 'config');
  const domain = credentialDomain({
    runner,
    sourceNodeId: activeRunner.sourceNodeId,
    configGeneration,
  });
  const authChannel = contextAuthChannel(runner);
  const origin = contextEndpointOrigin(runner);

  return {
    role: runnerRoleForActiveRole(input.role),
    kind: runner.kind,
    id: runnerId(runner),
    ...(runner.model !== undefined && { model: runner.model }),
    ...(authChannel !== undefined && { authChannel }),
    ...(origin !== undefined && { endpointOrigin: origin }),
    credentialPresent: domain !== undefined,
    ...(domain !== undefined && { credentialDomain: domain }),
    configGeneration,
  };
}

export function getRunnerDisplayName(runner: DeepReadonly<RunnerConfig>): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    case 'agent-sdk':
      return 'agent-sdk';
    default:
      return assertNever(runner);
  }
}

export function getRunnerCatalogDisplayName(runner: RunnerConfig): string {
  switch (runner.kind) {
    case 'cli':
      return getProviderDisplayName(runner.tool);
    case 'api':
      return getProviderDisplayName(runner.provider);
    case 'shell':
    case 'agent':
    case 'agent-sdk':
      return getProviderDisplayName(runner.kind);
    default:
      return assertNever(runner);
  }
}

export function getRunnerCommand(runner: RunnerConfig): string | undefined {
  if ('command' in runner && typeof runner.command === 'string') {
    return runner.command;
  }
  return undefined;
}

export function getRunnerApiKey(runner: RunnerConfig): string | undefined {
  if ('apiKey' in runner && typeof runner.apiKey === 'string') {
    return runner.apiKey;
  }
  return undefined;
}

export function getRunnerModelName(runner: DeepReadonly<RunnerConfig>): string | undefined {
  if ('model' in runner && typeof runner.model === 'string') {
    return runner.kind === 'cli'
      ? resolveCliModel(runner.model, runner.tool)
      : resolveAutoModel(runner.model, getRunnerDisplayName(runner));
  }
  return undefined;
}

export function getPlannerToolId(config: Config['planner']): PlannerToolId {
  switch (config.kind) {
    case 'cli':
      return config.tool;
    case 'api': {
      const provider = config.provider;
      return isPlannerToolId(provider) ? provider : 'anthropic';
    }
    case 'shell':
      return 'shell';
    case 'agent-sdk':
      return 'agent-sdk';
    case 'agent':
      return 'agent';
    default:
      return assertNever(config);
  }
}
