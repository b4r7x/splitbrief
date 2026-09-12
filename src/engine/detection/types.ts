import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import type { ScopedCliCatalogAttempt } from './cli-catalog-outcomes.js';

export const DETECTION_SOURCE_IDS = ['readiness', 'models-dev', 'cli-models'] as const;
export type DetectionSourceId = (typeof DETECTION_SOURCE_IDS)[number];

export const DETECTION_SOURCE_ERROR_KINDS = [
  'request-failed',
  'invalid-response',
  'missing-credential',
  'invalid-credential',
  'policy-denied',
  'timeout',
  'unsupported',
  'offline',
] as const;
export type DetectionSourceErrorKind = (typeof DETECTION_SOURCE_ERROR_KINDS)[number];

export interface DetectionSourceError {
  readonly kind: DetectionSourceErrorKind;
  readonly message: string;
}

export interface DetectionProjection {
  readonly providers: ProviderDetection[];
  readonly cliTools: CliToolDetection[];
  readonly configuredProviderOutcomes?: readonly ConfiguredProviderOutcome[] | undefined;
}

/** Memory-only, exact tool/context catalog probe outcomes. */
export type CliModelSnapshot = readonly ScopedCliCatalogAttempt[];

export interface DetectionSourceSnapshot<Value extends object> {
  readonly source: DetectionSourceId;
  readonly contextKey: string;
  readonly generation: number;
  readonly requestId: number;
  readonly fetchedAt: number;
  readonly validatedAt: number;
  readonly stale: boolean;
  readonly value: Value;
  readonly error?: DetectionSourceError | undefined;
}

export type DetectionSourceOutcome<Value extends object> =
  | Readonly<{
      kind: 'fresh';
      origin: 'request' | 'snapshot';
      snapshot: DetectionSourceSnapshot<Value>;
    }>
  | Readonly<{
      kind: 'stale';
      snapshot: DetectionSourceSnapshot<Value>;
    }>
  | Readonly<{
      kind: 'failed';
      source: DetectionSourceId;
      contextKey: string;
      generation: number;
      requestId: number;
      checkedAt: number;
      error: DetectionSourceError;
    }>
  | Readonly<{
      kind: 'not-run';
      source: DetectionSourceId;
      contextKey: string;
      reason: 'offline' | 'cancelled' | 'superseded' | 'uninitialized';
    }>;

type SourceRequestBase<Value extends object> = Readonly<{
  contextKey: string;
  ttlMs: number;
  mode: 'automatic' | 'manual';
  offline?: boolean | undefined;
  load: (signal: AbortSignal) => Promise<Value>;
  error: (cause: unknown) => DetectionSourceError;
}>;

export type ReadinessSourceRequest = SourceRequestBase<DetectionProjection> &
  Readonly<{ source: 'readiness' }>;

export type ModelsDevSourceRequest = SourceRequestBase<ModelsDevCatalog> &
  Readonly<{ source: 'models-dev' }>;

export type CliModelsSourceRequest = SourceRequestBase<CliModelSnapshot> &
  Readonly<{ source: 'cli-models' }>;

export type DetectionSourceRequest =
  | ReadinessSourceRequest
  | ModelsDevSourceRequest
  | CliModelsSourceRequest;

type SourceHydrationBase<Value extends object> = Readonly<{
  contextKey: string;
  value: Value;
  fetchedAt: number;
  validatedAt: number;
  generation?: number | undefined;
  requestId?: number | undefined;
  stale?: boolean | undefined;
  error?: DetectionSourceError | undefined;
}>;

export type ReadinessSourceHydration = SourceHydrationBase<DetectionProjection> &
  Readonly<{ source: 'readiness' }>;

export type ModelsDevSourceHydration = SourceHydrationBase<ModelsDevCatalog> &
  Readonly<{ source: 'models-dev' }>;

export type CliModelsSourceHydration = SourceHydrationBase<CliModelSnapshot> &
  Readonly<{ source: 'cli-models' }>;

export type DetectionSourceHydration =
  | ReadinessSourceHydration
  | ModelsDevSourceHydration
  | CliModelsSourceHydration;

export interface DetectionCoordinator {
  refresh(input: ReadinessSourceRequest): Promise<DetectionSourceOutcome<DetectionProjection>>;
  refresh(input: ModelsDevSourceRequest): Promise<DetectionSourceOutcome<ModelsDevCatalog>>;
  refresh(input: CliModelsSourceRequest): Promise<DetectionSourceOutcome<CliModelSnapshot>>;
  snapshot(
    input: Readonly<{ source: 'readiness'; contextKey: string }>,
  ): DetectionSourceSnapshot<DetectionProjection> | undefined;
  snapshot(
    input: Readonly<{ source: 'models-dev'; contextKey: string }>,
  ): DetectionSourceSnapshot<ModelsDevCatalog> | undefined;
  snapshot(
    input: Readonly<{ source: 'cli-models'; contextKey: string }>,
  ): DetectionSourceSnapshot<CliModelSnapshot> | undefined;
  cancel(input: Readonly<{ source: DetectionSourceId; contextKey?: string | undefined }>): void;
  invalidate(input: Readonly<{ source: DetectionSourceId; contextKey?: string | undefined }>): void;
  hydrate(input: ReadinessSourceHydration): void;
  hydrate(input: ModelsDevSourceHydration): void;
  hydrate(input: CliModelsSourceHydration): void;
}

export interface CreateDetectionCoordinatorOptions {
  readonly now?: (() => number) | undefined;
}

export interface DetectionContextIdentity {
  readonly platform: string;
  readonly runner: string;
  readonly executableFingerprint?: string | undefined;
  readonly executableVersion?: string | undefined;
  readonly authChannel?: string | undefined;
  readonly endpointOrigin?: string | undefined;
  /** Opaque source/config identity only; never a credential value or hash. */
  readonly credentialDomain?: string | undefined;
  readonly configGeneration: string;
}

export function detectionContextKey(input: DetectionContextIdentity): string {
  return [
    'detection-context-v1',
    input.platform,
    input.runner,
    input.executableFingerprint ?? 'no-executable-fingerprint',
    input.executableVersion ?? 'no-executable-version',
    input.authChannel ?? 'no-auth-channel',
    input.endpointOrigin ?? 'no-endpoint',
    input.credentialDomain ?? 'no-credential-domain',
    input.configGeneration,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

export function detectionSourceContextKey(
  input: Readonly<{
    source: DetectionSourceId;
    contextKey: string;
  }>,
): string {
  return `${encodeURIComponent(input.source)}|${encodeURIComponent(input.contextKey)}`;
}
