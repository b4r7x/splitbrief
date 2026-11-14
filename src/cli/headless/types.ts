import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import type { SeatDownPolicy } from '../../core/types/config-options.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { writeHeadlessJsonRecord } from '../../engine/events/public-json.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';

/** One headless run from its first pass to its exit; every step reads and writes it in place. */
export interface HeadlessRun {
  ref: SessionRef;
  plain: boolean;
  onSeatDown: SeatDownPolicy | undefined;
  writeRecord: typeof writeHeadlessJsonRecord;
  /** The preparation the next pass runs on: the entry's, or the one an admitted seat swap made. */
  prepared: PreparedExecution;
  savedState: WorkflowState | undefined;
  /** Under `--plain`, the last error the current pass published; printed when the run failed. */
  lastError: string | undefined;
}
