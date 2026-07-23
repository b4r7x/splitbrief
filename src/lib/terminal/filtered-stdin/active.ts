import type { FilteredStdin } from './types.js';

let activeFilteredStdin: FilteredStdin | undefined;

export function setActiveFilteredStdin(instance: FilteredStdin | undefined): void {
  activeFilteredStdin = instance;
}

export function getActiveFilteredStdin(): FilteredStdin | undefined {
  return activeFilteredStdin;
}
