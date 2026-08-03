import { getResponsivePanelWidth } from '../../utils/terminal-width.js';

// One width system for the picker and its sub-steps: the sub-panels derive from
// the picker's responsive width instead of clamping the terminal independently.
const PICKER_WIDTHS = { small: 76, large: 110 };
const SUB_PANEL_MAX_WIDTH = 64;

export function pickerPanelWidth(cols: number, isSmall: boolean): number {
  return getResponsivePanelWidth({
    cols,
    size: isSmall ? 'small' : 'large',
    widths: PICKER_WIDTHS,
  });
}

export function subPanelWidth(cols: number, isSmall: boolean): number {
  return Math.min(pickerPanelWidth(cols, isSmall), SUB_PANEL_MAX_WIDTH);
}
