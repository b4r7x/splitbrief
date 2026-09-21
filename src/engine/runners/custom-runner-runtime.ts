import type { ApprovalReviewResult } from '../../core/approval/types.js';
import {
  beginDeclaredArtifactReview,
  cleanupStaleArtifactReviews,
} from '../orchestrator/approval/planner-artifact.js';
import { createStagedProject } from '../orchestrator/approval/staged-project.js';
import type {
  ArtifactApprovalReview,
  CustomRunnerAdmissionPolicy,
  CustomRunnerRuntimePort,
} from './types.js';

export type ArtifactApprovalGate = (
  type: 'artifact',
  review: ArtifactApprovalReview,
) => Promise<ApprovalReviewResult>;

export type CustomRunnerRuntimeInput = Readonly<{
  projectDir: string;
  /**
   * The session that owns the artifact-review root, or — when
   * `sweepStaleReviews` is false — the name of a call that owns none.
   */
  sessionId: string;
  admission: CustomRunnerAdmissionPolicy;
  onArtifactApproval: ArtifactApprovalGate;
  /**
   * True for a session-owning caller: the artifact-review root it derives is
   * `.splitbrief/sessions/<id>`, so the sweep of stale reviews belongs to the
   * session. False for a one-shot command that owns no session and has no such
   * root — and needs none: the declared artifact lives and dies inside the
   * child's stage, which the lease creates, reads under a receipt and disposes
   * on its own. Only the sweep is session state, so there it is a no-op:
   * nothing was ever written to leave behind.
   */
  sweepStaleReviews: boolean;
}>;

/**
 * The custom-runner runtime a command hands to the runner factories. A `shell`
 * or `agent` seat declared in `customCommands` needs this port.
 *
 * Executable-resolution authority is captured from the host here, independently
 * of whatever stage a child later runs in: a stage supplies the child's cwd and
 * snapshot and nothing else.
 */
export function createCustomRunnerRuntime(
  input: CustomRunnerRuntimeInput,
): CustomRunnerRuntimePort {
  const authorizationPathEnv = process.env.PATH;
  const authorizationPathExt = process.env.PATHEXT;
  return {
    sessionId: input.sessionId,
    authorizationProjectDir: input.projectDir,
    sourceEnv: { ...process.env },
    ...(authorizationPathEnv !== undefined && { authorizationPathEnv }),
    ...(authorizationPathExt !== undefined && { authorizationPathExt }),
    createStage: async (sourceProjectDir) => {
      const staged = await createStagedProject(sourceProjectDir);
      return {
        projectDir: staged.projectDir,
        snapshot: staged.snapshot,
        cleanup: staged.cleanup,
      };
    },
    admission: input.admission,
    cleanupStaleArtifactReviews: () =>
      input.sweepStaleReviews
        ? cleanupStaleArtifactReviews({
            projectDir: input.projectDir,
            sessionId: input.sessionId,
          })
        : Promise.resolve(),
    beginDeclaredArtifactReview: (artifactInput) =>
      beginDeclaredArtifactReview({
        ...artifactInput,
        onApprovalNeeded: input.onArtifactApproval,
      }),
  };
}
