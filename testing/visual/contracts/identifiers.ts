import { z } from 'zod';
import { containsUnsafePathUnicode, isSafePersistedText } from './persisted-data.js';

const SAFE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTIFACT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const RELATIVE_ARTIFACT_PATH_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const WINDOWS_RESERVED_NAME_PATTERN =
  /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])$/i;

const SafeIdTextSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SAFE_ID_PATTERN)
  .refine((value) => !isWindowsReservedName(value), {
    message: 'ID is reserved by Windows',
  });

export const SafeIdSchema = SafeIdTextSchema.brand<'VisualSafeId'>();
export type SafeId = z.infer<typeof SafeIdSchema>;

export const ScenarioIdSchema = SafeIdTextSchema.brand<'VisualScenarioId'>();
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

export const CheckpointIdSchema = SafeIdTextSchema.brand<'VisualCheckpointId'>();
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;

export const ElementIdSchema = SafeIdTextSchema.brand<'VisualElementId'>();
export type ElementId = z.infer<typeof ElementIdSchema>;

export const ArtifactKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(ARTIFACT_KEY_PATTERN)
  .refine((value) => value.split(':').every((part) => !isWindowsReservedName(part)))
  .brand<'VisualArtifactKey'>();
export type ArtifactKey = z.infer<typeof ArtifactKeySchema>;

export const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(RELATIVE_ARTIFACT_PATH_PATTERN)
  .refine(isSafePersistedText, {
    message: 'artifact path contains unsafe persisted data',
  })
  .refine(isCanonicalRelativeArtifactPath)
  .brand<'VisualRelativeArtifactPath'>();
export type RelativeArtifactPath = z.infer<typeof RelativeArtifactPathSchema>;

export function safeId(value: string): SafeId {
  return SafeIdSchema.parse(value);
}

export function scenarioId(value: string): ScenarioId {
  return ScenarioIdSchema.parse(value);
}

export function checkpointId(value: string): CheckpointId {
  return CheckpointIdSchema.parse(value);
}

export function elementId(value: string): ElementId {
  return ElementIdSchema.parse(value);
}

export function artifactKey(value: string): ArtifactKey {
  return ArtifactKeySchema.parse(value);
}

export function relativeArtifactPath(value: string): RelativeArtifactPath {
  return RelativeArtifactPathSchema.parse(value);
}

export function isSafeId(value: unknown): value is SafeId {
  return SafeIdSchema.safeParse(value).success;
}

export function isWindowsReservedName(value: string): boolean {
  const normalizedAliases = value.replace(/¹/gu, '1').replace(/²/gu, '2').replace(/³/gu, '3');
  const withoutTrailingDotsOrSpaces = normalizedAliases.replace(/[ .]+$/u, '');
  const basename = withoutTrailingDotsOrSpaces.split('.')[0]?.replace(/[ .]+$/u, '') ?? '';
  return WINDOWS_RESERVED_NAME_PATTERN.test(basename);
}

function isCanonicalRelativeArtifactPath(value: string): boolean {
  if (containsUnsafePathUnicode(value) || value.includes('%') || value.includes(':')) return false;
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !/[ .]$/u.test(segment) &&
      !isWindowsReservedName(segment),
  );
}
