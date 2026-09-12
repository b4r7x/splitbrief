import type { DetectedModel } from './detection.js';

export type ModelKey = Readonly<{
  runnerId: string;
  sourceProviderId?: string;
  selectionId: string;
}>;

type AuthoritativeModelSource = 'cli' | 'runtime-account' | 'runtime-local';

export type ModelMembership = Readonly<{
  key: ModelKey;
}> &
  (
    | Readonly<{
        kind: 'automatic';
      }>
    | Readonly<{
        kind: 'confirmed';
        source: AuthoritativeModelSource;
        nativeOrder?: number;
        nativeDefault?: boolean;
      }>
    | Readonly<{
        kind: 'stale';
        source: AuthoritativeModelSource;
        nativeOrder?: number;
        nativeDefault?: boolean;
      }>
    | Readonly<{
        kind: 'bundled-suggestion';
        source: 'bundled';
      }>
    | Readonly<{
        kind: 'custom';
        source: 'configured' | 'user-entered';
      }>
  );

export type ModelProvenance =
  | Readonly<{
      kind: 'membership';
      source: AuthoritativeModelSource;
      freshness: 'current' | 'stale';
    }>
  | Readonly<{
      kind: 'metadata';
      source: 'native' | 'runtime' | 'models-dev';
    }>
  | Readonly<{
      kind: 'suggestion';
      source: 'models-dev' | 'bundled';
    }>
  | Readonly<{
      kind: 'automatic';
      source: 'splitbrief';
    }>
  | Readonly<{
      kind: 'custom';
      source: 'configured' | 'user-entered';
    }>;

type ModelMetadataFields = Readonly<
  Pick<
    DetectedModel,
    | 'displayName'
    | 'lifecycle'
    | 'releaseDate'
    | 'updatedDate'
    | 'maximumContextTokens'
    | 'effectiveContextTokens'
    | 'maximumInputTokens'
    | 'maximumOutputTokens'
    | 'inputModalities'
    | 'outputModalities'
    | 'supportsToolCalls'
    | 'supportsStructuredOutput'
  >
>;

export type ModelMetadata =
  | (ModelMetadataFields &
      Readonly<{
        source: 'native' | 'runtime' | 'bundled';
      }>)
  | (ModelMetadataFields &
      Readonly<{
        source: 'models-dev';
        providerId: string;
        modelId: string;
      }>);

export type ModelOption = ModelMembership &
  Readonly<{
    canConfigure: boolean;
    provenance: readonly ModelProvenance[];
    metadata: readonly ModelMetadata[];
  }>;

export function areModelKeysEqual({
  left,
  right,
}: Readonly<{
  left: ModelKey;
  right: ModelKey;
}>): boolean {
  return (
    left.runnerId === right.runnerId &&
    left.sourceProviderId === right.sourceProviderId &&
    left.selectionId === right.selectionId
  );
}

export function formatConservativeModelDisplay(selectionId: string): string {
  return selectionId;
}

export type ModelDisplayNameCandidate =
  | ModelOption
  | Readonly<{
      displayName?: string | undefined;
      selectionId?: string | undefined;
      id?: string | undefined;
      metadata?: readonly ModelMetadata[] | undefined;
      key?: ModelKey | undefined;
    }>;

export function resolveModelDisplayName(candidate: ModelDisplayNameCandidate): string {
  if ('metadata' in candidate && Array.isArray(candidate.metadata)) {
    for (const source of ['native', 'runtime', 'models-dev'] as const) {
      const displayName = candidate.metadata.find(
        (metadata) => metadata.source === source,
      )?.displayName;
      if (displayName) return displayName;
    }
  }

  if ('displayName' in candidate && typeof candidate.displayName === 'string') {
    return candidate.displayName;
  }

  const rawId =
    ('key' in candidate && candidate.key ? candidate.key.selectionId : undefined) ??
    ('selectionId' in candidate && typeof candidate.selectionId === 'string'
      ? candidate.selectionId
      : undefined) ??
    ('id' in candidate && typeof candidate.id === 'string' ? candidate.id : undefined) ??
    '';
  return formatConservativeModelDisplay(rawId);
}
