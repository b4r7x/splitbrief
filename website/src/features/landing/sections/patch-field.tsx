import { PanelStrip } from '../../../components/panel-strip.js';
import { PairingMatrix } from '../matrix/matrix.js';
import { IMPLEMENTER_JACK_IDS, PLANNER_JACK_IDS } from '../matrix/pairings.js';
import './patch-field.css';

export const PATCH_FIELD_ID = 'patch-field';

export function PatchFieldSection() {
  return (
    <PanelStrip className="patch-field" id={PATCH_FIELD_ID} legend="Patch field">
      <p className="patch-field__lead">
        {PLANNER_JACK_IDS.length} planners × {IMPLEMENTER_JACK_IDS.length} implementers are wired
        here — any supported pairing works. Every crossing emits a complete, schema-valid config.
      </p>
      <PairingMatrix />
    </PanelStrip>
  );
}
