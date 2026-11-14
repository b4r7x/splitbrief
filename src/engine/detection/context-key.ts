import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';

/**
 * Binds evidence to one active selection without serializing credential values.
 * Start derives this from config instead of trusting a returned evidence key.
 * The seat that asked and the complete endpoint are part of that selection:
 * reviewer and planner share an admission role but never an identity, and a
 * second base path on the same origin is a second endpoint. A legacy context
 * carries neither and keys on its admission role alone.
 */
export function runnerDiscoveryContextKey(context: RunnerDiscoveryContext): string {
  const credentialDomain = context.credentialDomain;
  const credentialDomainParts =
    credentialDomain === undefined
      ? ['credential-domain', 'absent']
      : [
          'credential-domain',
          'present',
          credentialDomain.providerId,
          credentialDomain.endpointOrigin,
          credentialDomain.authChannel,
          credentialDomain.credentialSource.kind,
          credentialDomain.credentialSource.kind === 'env'
            ? credentialDomain.credentialSource.name
            : credentialDomain.credentialSource.configNodeId,
          credentialDomain.credentialSource.kind === 'env'
            ? (credentialDomain.credentialSource.valueIdentity ?? 'unknown')
            : 'inline',
          credentialDomain.configGeneration,
        ];
  return [
    'runner-evidence-v2',
    context.role,
    context.seatRole ?? context.role,
    context.kind,
    context.id,
    context.model ?? 'unselected',
    context.authChannel ?? 'not-selected',
    context.endpointOrigin ?? 'none',
    context.endpointIdentity ?? 'none',
    context.credentialPresent ? 'credential-present' : 'credential-absent',
    ...credentialDomainParts,
    context.configGeneration,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}
