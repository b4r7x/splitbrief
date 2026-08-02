import type { RunnerRole } from '../../src/core/runners/cli-tool-catalog.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type PickerOption,
} from '../../src/features/runners/model-catalog/options.js';

/**
 * The option the picker would actually emit for `id`, built by the real
 * descriptor assembly and projection. Tests commit selections through this so a
 * fabricated model policy, billing posture or permission set cannot disagree
 * with the catalog the UI reads.
 */
export function realPickerOption(role: RunnerRole, id: string): PickerOption {
  const option = realPickerOptions(role).find((candidate) => candidate.id === id);
  if (!option) throw new Error(`no ${role} picker option for "${id}"`);
  return option;
}

export function realPickerOptions(role: RunnerRole): PickerOption[] {
  return buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    { cliTools: [], providers: [] },
    undefined,
  );
}
