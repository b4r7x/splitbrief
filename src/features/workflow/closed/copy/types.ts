import type { TaskSummaryState } from '../../components/task-summary/spans.js';
import type { CrewSeatId } from '../../../../core/crew/identity.js';
import type { StateTone } from '../../../../core/theme/state-tone.js';

/**
 * Theme keys, so a row says which colour it wants and the renderer indexes the theme instead of
 * translating a second vocabulary.
 */
export type CopyTone = 'text' | 'reviewFile' | StateTone | 'planner' | 'implementer' | 'reviewer';

export interface CopySegment {
  text: string;
  tone: CopyTone;
  /** The changed file this text names, which the block links into the project. */
  path?: string;
}

export type CopyFact = CopySegment | Readonly<{ spans: readonly CopySegment[] }>;

export interface RunRow {
  /** Empty on a follow-on row, which reads as part of the labelled row above it. */
  label: string;
  /** The seat a stage row reports on; its label wears the tone of that seat. */
  seat?: CrewSeatId;
  /** Each fact fits as one unit; the renderer joins facts with ` · `. */
  segments: readonly CopyFact[];
  /**
   * A prose row's lead length: its one fact wraps at words, each further line under the text
   * after the lead, so a sentence is never cut. A row without it is cut in the middle, as a path.
   */
  hang?: number;
  /** The rows a prose row may take; the summary quotes a note, the record keeps it whole. */
  maxLines?: number;
}

/** A row of the whole record: a run row, or one brief in the words the transcript settled it with. */
export type RecordRow = RunRow | Readonly<{ brief: BriefRowParts }>;

export interface FileRow {
  path: string;
  partial: boolean;
}

export interface BriefRowParts {
  id: string;
  title: string;
  state: Exclude<TaskSummaryState, { kind: 'stage' }>;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  fileNote?: string | undefined;
  extraFiles?: string | undefined;
  note?: string | undefined;
}

/** The summary whole, or only its labelled rows for a view too short to seat it whole. */
export type SummaryForm = 'whole' | 'labelled';
