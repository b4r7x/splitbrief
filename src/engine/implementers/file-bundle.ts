import { z } from 'zod';
import type { RunnerCallContext } from '../calls/types.js';

export const FILE_BUNDLE_MAX_FILES = 32;

export const FileBundleEntrySchema = z.strictObject({
  path: z.string(),
  action: z.enum(['create', 'modify']),
  content: z.string(),
});

/**
 * The BUILD response grammar `file-bundle-v1`: complete file contents for
 * declared targets only. Path spelling, target membership and byte limits are
 * checked by the parser against the captured targets, not by this shape.
 */
export const FileBundleSchema = z.strictObject({
  version: z.literal(1),
  files: z.array(FileBundleEntrySchema).min(1).max(FILE_BUNDLE_MAX_FILES),
});

/** @public */
export type FileBundleEntry = z.infer<typeof FileBundleEntrySchema>;
/** @public */
export type FileBundle = z.infer<typeof FileBundleSchema>;

export type BuildOutputContract = 'file-bundle-v1' | 'legacy-code-v1' | 'direct';

/**
 * The grammar a BUILD call is prompted for and parsed with. It is a property
 * of the backend alone, fixed before the prompt is built: every API call
 * (one file or many, first attempt, retry or continuation) asks for a bundle,
 * any other extracted-output backend keeps the legacy code grammar, and direct
 * writers stay direct. The response text never picks the grammar.
 */
export function selectBuildOutputContract(backend: {
  extractsCode: boolean;
  backendKind?: RunnerCallContext['backendKind'] | undefined;
}): BuildOutputContract {
  if (!backend.extractsCode) return 'direct';
  return backend.backendKind === 'api' ? 'file-bundle-v1' : 'legacy-code-v1';
}

/** @public */
export type BundleBaseline =
  | { path: string; operation: 'create'; kind: 'missing' }
  | {
      path: string;
      operation: 'modify';
      kind: 'text';
      content: string;
      sha256: string;
      mode: number;
    };

export interface AppliedFile {
  path: string;
  action: 'create' | 'modify';
  beforeSha256: string | null;
  afterSha256: string;
  /** Permission bits the writer verified; absent on older external results. */
  afterMode?: number;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Who the application answers for. `candidatePaths` is what the response asked
 * to change, which `untouched` cannot recover: after a stop it holds the
 * unreached candidates and the declared targets the response never named, and
 * those are not the same fact. `callId` is null for a refusal taken before any
 * call was dispatched, where there is no call to name.
 */
type BundleApplyProvenance = {
  callId: string | null;
  candidatePaths: string[];
};

export type BundleApplyResult = BundleApplyProvenance &
  (
    | { status: 'applied'; applied: AppliedFile[]; noops: string[]; untouched: string[] }
    | {
        status: 'rejected';
        code:
          | 'invalid-bundle'
          | 'unsafe-target'
          | 'denied'
          | 'baseline-conflict'
          | 'no-changes'
          | 'output-limit'
          | 'implausible-rewrite'
          | 'cancelled';
        error: string;
        applied: [];
        noops: string[];
        untouched: string[];
      }
    | {
        status: 'partial';
        code: 'io-failure' | 'write-uncertain' | 'baseline-conflict' | 'cancelled';
        error: string;
        failedPath: string;
        applied: AppliedFile[];
        noops: string[];
        untouched: string[];
      }
    | {
        status: 'failed';
        /** io-failure proves unchanged; write-uncertain requires disk reconciliation. */
        code: 'io-failure' | 'write-uncertain';
        error: string;
        failedPath: string;
        applied: [];
        noops: string[];
        untouched: string[];
      }
  );
