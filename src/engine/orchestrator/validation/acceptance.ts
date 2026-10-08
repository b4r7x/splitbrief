import type { ValidationStage } from '../../../core/schemas/enums.js';

export type ValidationAcceptance = {
  accepted: boolean;
  exemptStages: readonly ValidationStage[];
  blockingStages: readonly ValidationStage[];
};
