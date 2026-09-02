import { parseApiKeyEnvRef } from '../credentials.js';
import { readActiveRunnerLens } from './active-runner.js';
import { assertNever } from '../../../utils/type-guards.js';
import { contentIdentityId } from './content-identity.js';
import type { Config } from '../../schemas/config.js';
import type { ActiveRunnerConfig } from './active-runner.js';
import { defaultCliAuthChannel, type CliAuthChannelId } from '../../runners/cli-tool-catalog.js';
import {
  runnerRoleForActiveRole,
  type ActiveRunnerRole,
  type RunnerRole,
} from '../../runners/seat-roles.js';

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

function runnerId(runner: ActiveRunnerConfig): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    case 'shell':
    case 'agent':
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
  if (runner.kind === 'api') return 'api-key';
  return undefined;
}

function contextEndpointOrigin(runner: ActiveRunnerConfig): string | undefined {
  if (runner.kind === 'api') return endpointOrigin(runner.apiBase);
  return undefined;
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
