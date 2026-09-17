import { isDeepStrictEqual } from 'node:util';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import {
  InvocationIdentitySchema,
  type InvocationIdentity,
} from '../../core/schemas/invocation-identity.js';
import { error } from '../../utils/error.js';
import { sha256Hex } from '../../utils/sha256.js';
import { isRemoteBackedOllamaModel } from '../providers/ollama.js';
import type { ApiDispatchAuthentication, ProviderDef } from '../providers/types.js';
import type { RunnerCallContext } from '../calls/types.js';
import {
  enforceCliAuthInvocation,
  type CliInvocation,
  type CliInvocationAuthEvidence,
} from './cli-auth-enforcement.js';

type CliRunner = Parameters<typeof enforceCliAuthInvocation>[0]['runner'];

function receiptMismatch(runner: CliRunner, invocation: CliInvocation): never {
  throw error(
    'runner-auth-evidence-mismatch',
    `The authentication receipt for CLI tool "${runner.tool}" was issued for another invocation, binary or channel, so it is not reused.`,
    { tool: runner.tool, callId: invocation.callId },
  );
}

/**
 * The durable identity of one CLI invocation, taken once its executable, env
 * and argv are final and its auth evidence was admitted for it. The runner
 * contributes only its raw configured channel, which proves nothing; method and
 * billing facts come solely from a receipt bound to this call, this binary and
 * that channel. A receipt issued for anything else is refused, never reused.
 */
export function snapshotCliInvocationIdentity({
  runner,
  invocation,
  authEvidence,
  now,
}: Readonly<{
  runner: CliRunner;
  invocation: CliInvocation;
  authEvidence: CliInvocationAuthEvidence;
  now: number;
}>): InvocationIdentity {
  const base = {
    version: 1,
    capturedAt: now,
    runner: { kind: 'cli', id: runner.tool },
    ...(runner.authChannel !== undefined && { configuredChannel: runner.authChannel }),
  } as const;
  if (authEvidence.kind === 'host-configured') {
    return { ...base, billing: { posture: 'unknown', basis: 'unknown' } };
  }

  if (
    authEvidence.invocationId !== invocation.callId ||
    !isDeepStrictEqual(authEvidence.executableFingerprint, invocation.executable.fingerprint) ||
    authEvidence.channel !== runner.authChannel ||
    (authEvidence.kind === 'enforced' &&
      (authEvidence.platform !== invocation.platform ||
        authEvidence.installedVersion !== invocation.installedVersion))
  ) {
    return receiptMismatch(runner, invocation);
  }

  const channel = { channel: authEvidence.channel, evidenceId: authEvidence.evidenceId };
  const billing =
    authEvidence.billingPosture === 'unknown'
      ? ({ posture: 'unknown', basis: 'unknown' } as const)
      : {
          posture: authEvidence.billingPosture,
          basis:
            authEvidence.kind === 'enforced'
              ? ('enforced-channel' as const)
              : ('observed-invocation' as const),
          evidenceId: authEvidence.evidenceId,
        };
  return authEvidence.kind === 'enforced'
    ? { ...base, enforcedChannel: channel, billing }
    : { ...base, observedChannel: channel, billing };
}

/**
 * Admits one CLI call's raw auth channel and fixes its identity on the call
 * context before the recorder emits `call_started`. An explicit method without
 * current proof throws here, so nothing is spawned or recorded.
 */
export function withCliInvocationIdentity({
  runner,
  callContext,
  executable,
}: Readonly<{
  runner: CliRunner;
  callContext: RunnerCallContext;
  executable: CliExecutableIdentity;
}>): RunnerCallContext {
  // No admitted installed version reaches dispatch, so an explicit method is
  // refused rather than bound to a version nobody checked.
  const invocation: CliInvocation = {
    callId: callContext.callId,
    executable,
    installedVersion: undefined,
    platform: process.platform,
  };
  const authEvidence = enforceCliAuthInvocation({ runner, invocation });
  return {
    ...callContext,
    invocationIdentity: snapshotCliInvocationIdentity({
      runner,
      invocation,
      authEvidence,
      now: Date.now(),
    }),
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
