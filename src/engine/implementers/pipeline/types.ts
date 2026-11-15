import type { ImplementerOptions, ImplementerPublisher } from '../types.js';
import type { BuildOutputContract } from '../file-bundle/contract.js';
import type { ChangeDetector } from '../../change-detection.js';

/** What a bundle read and write takes from its implementer seat. */
export type BundleSeat = Readonly<{
  outputContract: BuildOutputContract;
  publisher: ImplementerPublisher | undefined;
  createdByTask: Map<string, Set<string>>;
  failTask: (opts: ImplementerOptions, error: string) => void;
}>;

export type CallSeat = BundleSeat & Readonly<{ detectChanges: ChangeDetector | undefined }>;
