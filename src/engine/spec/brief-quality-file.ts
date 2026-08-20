import { BRIEF_QUALITY_FILE } from '../../core/paths.js';
import { writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { briefQualityVerdict } from './brief-quality.js';

export const BRIEF_QUALITY_RULE_VERSION = 'brief-quality-v1';

/**
 * The issue list a brief-quality report carries. Committed evidence hands the
 * issues back as opaque records, so the bytes keep whatever was recorded
 * instead of re-deriving a shape the admitted hash was never computed over.
 */
export type BriefQualityFileContent = Readonly<{
  issues: readonly unknown[];
  briefHash?: string | undefined;
}>;

/**
 * The sole serialization of `brief-quality.json`. Its bytes are the hashed
 * contract: whoever records the admitted report hash must hash this output,
 * and whoever writes the file must write this output, so a byte-hash reader
 * matches by construction.
 */
export function briefQualityReportBytes(content: BriefQualityFileContent): string {
  const verdict = briefQualityVerdict(content.issues);
  return JSON.stringify(
    {
      version: 1,
      passed: verdict.passed,
      score: verdict.score,
      issues: content.issues,
      ...(content.briefHash === undefined ? {} : { briefHash: content.briefHash }),
      ruleVersion: BRIEF_QUALITY_RULE_VERSION,
    },
    null,
    2,
  );
}

export function writeBriefQualityReport(
  input: Readonly<{
    ref: SessionRef;
    content: BriefQualityFileContent;
    metadata?: SpecMetadata | null | undefined;
  }>,
): void {
  writeSpecFile(
    input.ref,
    BRIEF_QUALITY_FILE,
    briefQualityReportBytes(input.content),
    input.metadata ?? null,
  );
}
