import type { SpecMetadata } from '../../core/paths-io.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../core/paths.js';
import type { BriefGenerationRef } from '../../core/schemas/brief-owner.js';
import { admitPlanningArtifact } from '../spec/planning-artifact-admission.js';
import type { EventBus } from '../events/types.js';
import { publishArtifactWritten } from './artifact-card.js';
import type { Phase } from '../../core/schemas/enums.js';
import { error } from '../../utils/error.js';

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
  /** Committed generation receipt; required for fixed-name Tasks projections. */
  generation?: BriefGenerationRef | undefined;
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
  generation?: BriefGenerationRef | undefined;
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
  projectDir: string;
  sessionId: string;
  phase: Phase;
  kind: ArtifactKind;
  text: string;
  metadata?: SpecMetadata | null | undefined;
  admission?: ArtifactAdmission | undefined;
  generation?: BriefGenerationRef | undefined;
}>;

/**
 * Validate one artifact before any byte changes: spec and plan replacements
 * are admitted first, and fixed-name Tasks projections require the committed
 * generation receipt. The receipt gates the write and its event; execution
 * authority stays in the owner state, never in these files.
 */
function prepareArtifact(opts: ArtifactPrepareOptions): PreparedArtifact {
  const filename = ARTIFACT_FILENAMES[opts.kind];
  if (opts.kind === 'task-briefs' && opts.generation === undefined) {
    throw error(
      'artifact-projection-requires-generation',
      'fixed tasks.md projections require a committed generation receipt',
      { filename },
    );
  }
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
 * to keep admission at its original boundary. Research skips planning admission; fixed Tasks
 * projections require a committed generation receipt.
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
 * fault therefore never touches owner state and cannot authorize an older or
 * mixed generation.
 */
export function writeAndPublishArtifacts(opts: ArtifactBatchWriteOptions): void {
  const prepared = opts.items.map((item) =>
    prepareArtifact({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      phase: opts.phase,
      kind: item.kind,
      text: item.text,
      metadata: opts.metadata,
      admission: item.admission,
      generation: opts.generation,
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
