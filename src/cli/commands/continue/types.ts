import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { ContinueActionOption } from '../../options/continue-action.js';

export type ContinueOpts = { projectDir: string } & WorkflowOpts & {
    action?: ContinueActionOption | undefined;
  };

export type SwitchedSeat = Readonly<{
  seat: CrewSeatId;
  profile?: string | undefined;
  config: Config;
}>;

/** What a continue step hands to the re-entry; a step that ended the command returns `undefined`. */
export type Resumed = { state: WorkflowState; config?: Config; seatSwitch?: SwitchedSeat };
