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
        kind: 'catalog-suggestion';
        source: 'models-dev';
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

export function resolveModelDisplayName(option: ModelOption): string {
  for (const source of ['native', 'runtime', 'models-dev'] as const) {
    const displayName = option.metadata.find((metadata) => metadata.source === source)?.displayName;
    if (displayName) return displayName;
  }

  return formatConservativeModelDisplay(option.key.selectionId);
}
