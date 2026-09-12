import type { Phase } from '../schemas/enums.js';
import type { MachineAction } from './types.js';
import { error } from '../../utils/error.js';

export const transitionError = {
  invalidActionForPhase: (phase: Phase, action: MachineAction['type']) =>
    error(
      'state-invalid-action-for-phase',
      `Cannot apply ${action} while workflow is in ${phase}.`,
      { phase, action },
    ),
} as const;
