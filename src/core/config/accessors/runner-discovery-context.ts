import { parseApiKeyEnvRef } from '../credentials.js';
import { readActiveRunnerLens } from './active-runner.js';
import { API_PROVIDER_CATALOG } from '../../providers/api-provider-catalog.js';
import { assertNever } from '../../../utils/type-guards.js';
import { contentIdentityId } from './content-identity.js';
import type { Config } from '../../schemas/config.js';
import type { ActiveRunnerConfig } from './active-runner.js';
import {
  defaultCliAuthChannel,
  runnerRoleForActiveRole,
  type ActiveRunnerRole,
  type CliAuthChannelId,
  type RunnerRole,
} from '../../runners/cli-tool-catalog.js';

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
  readonly kind: ActiveRunnerConfig['kind'];
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

const configGenerationId = (config: Config): string => contentIdentityId('config', config);

function endpointOrigin(apiBase: string): string {
  return new URL(apiBase).origin;
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

function runnerId(runner: ActiveRunnerConfig): string {
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
  runner: Extract<ActiveRunnerConfig, { kind: 'api' }>;
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
  runner: Extract<ActiveRunnerConfig, { kind: 'agent-sdk' }>;
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
  runner: ActiveRunnerConfig;
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

function contextAuthChannel(runner: ActiveRunnerConfig): CliAuthChannelId | undefined {
  if (runner.kind === 'cli') return runner.authChannel ?? defaultCliAuthChannel(runner.tool).id;
  if (runner.kind === 'api' || runner.kind === 'agent-sdk') return 'api-key';
  return undefined;
}

function contextEndpointOrigin(runner: ActiveRunnerConfig): string | undefined {
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
  const configGeneration = configGenerationId(input.config);
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
