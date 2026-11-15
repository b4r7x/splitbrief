import type { ApiProviderId } from '../../../core/providers/api-catalog.js';
import type { SeatPickerRole } from '../../../core/runners/seat-roles.js';
import type { LocalConnectionProbe, LocalConnectionSave, LocalConnectionSeat } from './model.js';

export interface LocalConnectionFormProps {
  role: SeatPickerRole;
  provider: ApiProviderId;
  seat: LocalConnectionSeat;
  check: LocalConnectionProbe;
  onSave: (input: LocalConnectionSave) => void;
}
