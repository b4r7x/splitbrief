import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import {
  InvocationIdentitySchema,
  type InvocationIdentity,
} from '../../core/schemas/invocation-identity.js';
import { sha256Hex } from '../../utils/sha256.js';
import { isRemoteBackedOllamaModel } from '../providers/ollama.js';
import type { ApiDispatchAuthentication, ProviderDef } from '../providers/types.js';
import type { RunnerCallContext } from '../calls/types.js';

/**
 * The durable identity of one CLI invocation. The tool's own sign-in decides
 * how the call authenticates and what it bills to, so the record names only
 * the tool, and its billing is unknown.
 */
export function snapshotCliInvocationIdentity({
  tool,
  now,
}: Readonly<{ tool: CliToolId; now: number }>): InvocationIdentity {
  return {
    version: 1,
    capturedAt: now,
    runner: { kind: 'cli', id: tool },
    billing: { posture: 'unknown', basis: 'unknown' },
  };
}

/** Fixes one CLI call's identity on its call context before the recorder emits `call_started`. */
export function withCliInvocationIdentity({
  tool,
  callContext,
}: Readonly<{ tool: CliToolId; callContext: RunnerCallContext }>): RunnerCallContext {
  return {
    ...callContext,
    invocationIdentity: snapshotCliInvocationIdentity({ tool, now: Date.now() }),
  };
}

/**
 * Transport-policy evidence for one API dispatch: the resolved provider's
 * endpoint passed its catalog loopback policy. `remoteBacked` records a model
 * the local server is known to route upstream.
 */
export type ApiLocalityEvidence = Readonly<{
  transport: 'loopback';
  evidenceId: string;
  remoteBacked: boolean;
}>;

/** The nonsecret facts a resolved provider contributes to its dispatch identity. */
export type ApiInvocationEvidence = Readonly<{
  dispatchAuthentication: ApiDispatchAuthentication;
  localityEvidence?: ApiLocalityEvidence | undefined;
}>;

const API_AUTHENTICATION_EVIDENCE = {
  'api-key': 'api.credential.configured',
  none: 'api.credential.empty',
} as const;

const identityShape = InvocationIdentitySchema.shape;

/**
 * An opaque digest of the provider and its full endpoint. Userinfo, query and
 * fragment are dropped before hashing, and an endpoint that does not parse has
 * no key rather than a raw one.
 */
export function apiConnectionKey(provider: string, apiBase: string): string | undefined {
  if (!URL.canParse(apiBase)) return undefined;
  const url = new URL(apiBase);
  const endpoint = `${url.protocol}//${url.host}${url.pathname}`;
  return `api:${sha256Hex(`${provider}\n${endpoint}`).slice(0, 32)}`;
}

/**
 * Reads the evidence off the provider that builds the client. Only a catalog
 * provider whose endpoint policy is loopback proves local transport; a custom
 * endpoint on localhost proves nothing about where the model runs.
 */
export function apiInvocationEvidence(provider: ProviderDef, model: string): ApiInvocationEvidence {
  const dispatchAuthentication = provider.dispatchAuthentication?.() ?? 'unknown';
  const descriptor = getApiProviderDescriptor(provider.name);
  if (descriptor?.endpointPolicy.kind !== 'loopback') return { dispatchAuthentication };
  return {
    dispatchAuthentication,
    localityEvidence: {
      transport: 'loopback',
      evidenceId: `api.${descriptor.id}.loopback-transport`,
      remoteBacked: descriptor.id === 'ollama' && isRemoteBackedOllamaModel(model),
    },
  };
}

/**
 * The durable identity of one direct API request, taken at dispatch for the
 * exact model and connection. The credential source decides the method only
 * when it proves one; neither it nor HTTP transport names a tariff. Proven
 * loopback transport bills as local unless the model is routed upstream.
 */
export function snapshotApiInvocationIdentity({
  provider,
  model,
  connectionKey,
  configuredChannel,
  dispatchAuthentication,
  localityEvidence,
  now,
}: Readonly<{
  provider: string | undefined;
  model: string;
  connectionKey: string | undefined;
  configuredChannel?: InvocationIdentity['configuredChannel'];
  dispatchAuthentication: ApiDispatchAuthentication;
  localityEvidence?: ApiLocalityEvidence | undefined;
  now: number;
}>): InvocationIdentity {
  const localBilling =
    localityEvidence !== undefined && !localityEvidence.remoteBacked
      ? ({
          posture: 'local',
          basis: 'local-transport',
          evidenceId: localityEvidence.evidenceId,
        } as const)
      : undefined;
  return {
    version: 1,
    capturedAt: now,
    runner: {
      kind: 'api',
      ...(provider !== undefined &&
        identityShape.runner.shape.id.safeParse(provider).success && { id: provider }),
    },
    ...(identityShape.model.safeParse(model).success && { model }),
    ...(connectionKey !== undefined && { connectionKey }),
    ...(configuredChannel !== undefined && { configuredChannel }),
    ...(dispatchAuthentication !== 'unknown' && {
      observedChannel: {
        channel: dispatchAuthentication,
        evidenceId: API_AUTHENTICATION_EVIDENCE[dispatchAuthentication],
      },
    }),
    billing: localBilling ?? { posture: 'unknown', basis: 'unknown' },
  };
}
