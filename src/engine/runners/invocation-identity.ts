import type { CliToolId } from '../../core/runners/cli-tool/types.js';
import {
  InvocationIdentitySchema,
  type InvocationIdentity,
} from '../../core/schemas/invocation-identity.js';
import { sha256Hex } from '../../utils/sha256.js';
import type { ApiDispatchAuthentication, ProviderDef } from '../providers/types.js';
import type { RunnerCallContext } from '../calls/types.js';

export function snapshotCliInvocationIdentity({
  tool,
  now,
}: Readonly<{ tool: CliToolId; now: number }>): InvocationIdentity {
  return {
    version: 1,
    capturedAt: now,
    runner: { kind: 'cli', id: tool },
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

export type ApiInvocationEvidence = Readonly<{
  dispatchAuthentication: ApiDispatchAuthentication;
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

export function apiInvocationEvidence(provider: ProviderDef): ApiInvocationEvidence {
  return { dispatchAuthentication: provider.dispatchAuthentication?.() ?? 'unknown' };
}

export function snapshotApiInvocationIdentity({
  provider,
  model,
  connectionKey,
  configuredChannel,
  dispatchAuthentication,
  now,
}: Readonly<{
  provider: string | undefined;
  model: string;
  connectionKey: string | undefined;
  configuredChannel?: InvocationIdentity['configuredChannel'];
  dispatchAuthentication: ApiDispatchAuthentication;
  now: number;
}>): InvocationIdentity {
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
  };
}
