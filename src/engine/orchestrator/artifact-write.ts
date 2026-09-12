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

export type ArtifactBatchItem = Readonly<{
  kind: ArtifactKind;
  text: string;
  admission?: ArtifactAdmission | undefined;
}>;

export type ArtifactBatchWriteOptions = Readonly<{
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
  items: readonly ArtifactBatchItem[];
  metadata?: SpecMetadata | null | undefined;
}>;

const ARTIFACT_FILENAMES: Record<ArtifactKind, string> = {
  research: RESEARCH_FILE,
  spec: SPEC_FILE,
  plan: PLAN_FILE,
  'task-briefs': TASKS_FILE,
};

type PreparedArtifact = Readonly<{
  filename: string;
  text: string;
  metadata: SpecMetadata | null | undefined;
}>;

type ArtifactPrepareOptions = Readonly<{
  kind: ArtifactKind;
  text: string;
  metadata?: SpecMetadata | null | undefined;
  admission?: ArtifactAdmission | undefined;
}>;

/**
 * Validate one artifact before any byte changes: spec and plan replacements
 * are admitted first.
 */
function prepareArtifact(opts: ArtifactPrepareOptions): PreparedArtifact {
  const filename = ARTIFACT_FILENAMES[opts.kind];
  if ((opts.kind === 'spec' || opts.kind === 'plan') && opts.admission !== 'already-admitted') {
    admitPlanningArtifact({
      phase: opts.kind === 'spec' ? 'specifying' : 'planning',
      filename,
      text: opts.text,
    });
  }
  return { filename, text: opts.text, metadata: opts.metadata };
}

/**
 * Persist one planner artifact and announce the persisted document as one card.
 *
 * Spec and plan replacements are admitted before `writeSpecFile` can create a directory, mutate
 * a file, or publish an event. Callers that already admitted a planner phase can say so explicitly
 * to keep admission at its original boundary. Research skips planning admission.
 */
export function writeAndPublishArtifact(opts: ArtifactWriteOptions): void {
  const prepared = prepareArtifact(opts);
  writeSpecFile(
    { projectDir: opts.projectDir, sessionId: opts.sessionId },
    prepared.filename,
    prepared.text,
    prepared.metadata,
  );
  publishArtifactWritten({
    bus: opts.bus,
    phase: opts.phase,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    filename: prepared.filename,
    text: prepared.text,
  });
}

/**
 * Persist a whole array of planner artifacts as compatibility projections.
 *
 * Every item is validated before any file is written, so an invalid later item
 * cannot expose a partial batch; files are written only after all items pass
 * and events are published only after every write succeeded. A projection
 * fault therefore never touches owner state.
 */
export function writeAndPublishArtifacts(opts: ArtifactBatchWriteOptions): void {
  const prepared = opts.items.map((item) =>
    prepareArtifact({
      kind: item.kind,
      text: item.text,
      metadata: opts.metadata,
      admission: item.admission,
    }),
  );
  for (const item of prepared) {
    writeSpecFile(
      { projectDir: opts.projectDir, sessionId: opts.sessionId },
      item.filename,
      item.text,
      item.metadata,
    );
  }
  for (const item of prepared) {
    publishArtifactWritten({
      bus: opts.bus,
      phase: opts.phase,
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      filename: item.filename,
      text: item.text,
    });
  }
}
