import type { Phase } from '../../core/schemas/enums.js';
import type { EventBus } from '../events/types.js';

export type BusContext = {
  bus: EventBus;
  phase: Phase;
};
