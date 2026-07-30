import { useId } from 'react';
import {
  IMPLEMENTER_JACK_IDS,
  IMPLEMENTER_JACKS,
  PLANNER_JACK_IDS,
  PLANNER_JACKS,
  type PairingSelection,
} from './pairings.js';

export interface PairingPickerProps {
  readonly selected: PairingSelection;
  readonly onSelect: (selection: PairingSelection) => void;
}

// biome-ignore-start lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML permits radiogroup on fieldset, preserving native legend semantics.
export function PairingPicker({ selected, onSelect }: PairingPickerProps) {
  const pickerId = useId();
  const plannerLegendId = `${pickerId}-planner-legend`;
  const implementerLegendId = `${pickerId}-implementer-legend`;

  return (
    <div className="pairing-picker">
      <fieldset
        aria-labelledby={plannerLegendId}
        className="pairing-picker__group"
        role="radiogroup"
      >
        <legend className="pairing-picker__legend" id={plannerLegendId}>
          Planner
        </legend>
        <div className="pairing-picker__options">
          {PLANNER_JACK_IDS.map((plannerId) => {
            const isSelected = plannerId === selected.plannerId;

            return (
              <label
                className="pairing-picker__option"
                data-selected={isSelected ? 'true' : undefined}
                key={plannerId}
              >
                <input
                  checked={isSelected}
                  className="pairing-picker__input"
                  data-jack-id={plannerId}
                  data-jack-side="planner"
                  name={`${pickerId}-planner`}
                  onChange={() => onSelect({ ...selected, plannerId })}
                  tabIndex={isSelected ? 0 : -1}
                  type="radio"
                  value={plannerId}
                />
                <span aria-hidden="true" className="pairing-picker__pin" />
                <span className="pairing-picker__label">{PLANNER_JACKS[plannerId].label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset
        aria-labelledby={implementerLegendId}
        className="pairing-picker__group"
        role="radiogroup"
      >
        <legend className="pairing-picker__legend" id={implementerLegendId}>
          Implementer
        </legend>
        <div className="pairing-picker__options">
          {IMPLEMENTER_JACK_IDS.map((implementerId) => {
            const isSelected = implementerId === selected.implementerId;

            return (
              <label
                className="pairing-picker__option"
                data-selected={isSelected ? 'true' : undefined}
                key={implementerId}
              >
                <input
                  checked={isSelected}
                  className="pairing-picker__input"
                  data-jack-id={implementerId}
                  data-jack-side="implementer"
                  name={`${pickerId}-implementer`}
                  onChange={() => onSelect({ ...selected, implementerId })}
                  tabIndex={isSelected ? 0 : -1}
                  type="radio"
                  value={implementerId}
                />
                <span aria-hidden="true" className="pairing-picker__pin" />
                <span className="pairing-picker__label">
                  {IMPLEMENTER_JACKS[implementerId].label}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
// biome-ignore-end lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML permits radiogroup on fieldset, preserving native legend semantics.
