import type {
  BriefOwnerCommitPort,
  BriefOwnerCommitResult,
} from '../../src/core/schemas/brief-owner.js';
import type { BriefRecoveryStateView } from '../../src/core/schemas/brief-recovery/document.js';

type TestOwnerCommitOptions = Readonly<{
  onCommit?: ((state: BriefRecoveryStateView) => void) | undefined;
  fail?: boolean | undefined;
  failOnCommit?: number | undefined;
}>;

export function makeTestOwnerCommit(options: TestOwnerCommitOptions = {}): BriefOwnerCommitPort {
  let commits = 0;
  let view: BriefRecoveryStateView = {
    stateVersion: 4,
    stateRevision: 0,
    stateFence: { token: 1, ownerId: 'test-owner' },
    phase: 'reviewing-briefs',
    briefRecovery: null,
  };
  return (input): BriefOwnerCommitResult => {
    commits += 1;
    if (options.fail === true || options.failOnCommit === commits) {
      throw new Error('owner commit failed');
    }
    const evidenceRef = {
      revision: 1 as const,
      hash: '0'.repeat(64),
      path: 'brief-recovery/test-evidence.json',
    };
    const patch = input.projectNext({
      current: view,
      evidenceRef,
      eventId: input.event.eventId,
    });
    view = patch.recovery;
    options.onCommit?.(view);
    return {
      kind: 'committed',
      stateRevision: {
        rawSha256: input.expected.stateRevision.rawSha256,
        fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
      },
      authorityRevision: patch.authorityRevision,
      recovery: patch.recovery,
      generation: patch.generation,
      permit: patch.permit,
    };
  };
}
