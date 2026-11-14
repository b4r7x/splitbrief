import type { open } from 'node:fs/promises';
import type {
  DeclaredArtifactProvenance,
  DeclaredArtifactReceipt,
  DeclaredArtifactRead,
} from '../../../runners/types.js';
import type { ArtifactStageEntry } from './capture.js';

export type ArtifactFileHandle = Awaited<ReturnType<typeof open>>;

export type ArtifactLeaseAncestryEntry = Readonly<{
  path: string;
  entry: ArtifactStageEntry;
}>;

export type ArtifactLeaseProvenance = DeclaredArtifactProvenance;

export type ArtifactLeaseReceipt = DeclaredArtifactReceipt;

export type ArtifactStageRead = DeclaredArtifactRead;

export type ArtifactStageLease = Readonly<{
  artifactPath: string;
  readWithReceiptAfterChild: (
    input: Readonly<{ declaredRedactionValues: readonly string[] }>,
  ) => Promise<ArtifactStageRead>;
  revalidateBeforePromotion: () => Promise<string>;
  getReceipt: () => ArtifactLeaseReceipt | undefined;
  dispose: () => Promise<void>;
}>;

export type PrepareArtifactStageLeaseInput = Readonly<{
  stagedProjectDir: string;
  provenance: unknown;
}>;

export type LeasePreparation = Readonly<{
  stagedProjectDir: string;
  artifactPath: string;
  artifactRelativePath: string;
  manifestRoot: string;
  scopeRoot: string;
  maxBytes: number;
  provenance: ArtifactLeaseProvenance;
}>;

export type ReviewedArtifact = Readonly<{
  text: string;
  digest: string;
  receipt: ArtifactLeaseReceipt;
}>;
