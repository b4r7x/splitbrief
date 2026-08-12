import type { SpecMetadata } from '../../core/paths-io.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../core/paths.js';
import { admitPlanningArtifact } from '../spec/planning-artifact-admission.js';
import type { EventBus } from '../events/types.js';
import { publishArtifactWritten } from './artifact-card.js';
import type { Phase } from '../../core/schemas/enums.js';

export type ArtifactKind = 'research' | 'spec' | 'plan' | 'task-briefs';

export type ArtifactAdmission = 'required' | 'already-admitted';

export type ArtifactWriteOptions = {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
  kind: ArtifactKind;
  text: string;
  metadata?: SpecMetadata | null | undefined;
  admission?: ArtifactAdmission | undefined;
};

const ARTIFACT_FILENAMES: Record<ArtifactKind, string> = {
  research: RESEARCH_FILE,
  spec: SPEC_FILE,
  plan: PLAN_FILE,
  'task-briefs': TASKS_FILE,
};

/**
 * Persist one planner artifact and announce the persisted document as one card.
 *
 * Spec and plan replacements are admitted before `writeSpecFile` can create a directory, mutate
 * a file, or publish an event. Callers that already admitted a planner phase can say so explicitly
 * to keep admission at its original boundary. Research and Task Briefs deliberately skip planning
 * admission because their downstream consumers own those contracts.
 */
export function writeAndPublishArtifact(opts: ArtifactWriteOptions): void {
  const filename = ARTIFACT_FILENAMES[opts.kind];
  if ((opts.kind === 'spec' || opts.kind === 'plan') && opts.admission !== 'already-admitted') {
    admitPlanningArtifact({
      phase: opts.kind === 'spec' ? 'specifying' : 'planning',
      filename,
      text: opts.text,
    });
  }

  writeSpecFile(
    { projectDir: opts.projectDir, sessionId: opts.sessionId },
    filename,
    opts.text,
    opts.metadata,
  );
  publishArtifactWritten({
    bus: opts.bus,
    phase: opts.phase,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    filename,
    text: opts.text,
  });
}
