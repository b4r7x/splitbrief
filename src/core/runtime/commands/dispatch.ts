import type { Phase } from '../../schemas/enums.js';
import type { Screen } from '../../navigation/types.js';
import type { RuntimeCommandDef } from './types.js';
import { findRuntimeCommand, removedCommandPointer, suggestRuntimeCommand } from './lookup.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

interface CommandExecutionOptions {
  screen: Screen;
  phase: Phase;
  plannerSupportsImages: boolean;
  openRunAtRest: boolean;
  applyUnfinished: boolean;
  applying: boolean;
  /**
   * Called once for a command that does not run or that fails, with the reason (also the message of
   * an error that the handler throws), the line as typed, and whether the command was refused or
   * its handler threw.
   */
  onError: (msg: string, raw: string, outcome: 'refused' | 'failed') => void;
}

export async function executeRuntimeCommand(
  commands: RuntimeCommandDef[],
  raw: string,
  options: CommandExecutionOptions,
): Promise<void> {
  const parts = raw.split(' ');
  const name = (parts[0] ?? '').toLowerCase();
  const typed = parts.slice(1).join(' ').trim();
  const cmd = findRuntimeCommand(commands, name);
  if (!cmd) {
    const pointer = removedCommandPointer(name);
    if (pointer) {
      options.onError(`${name} was removed: ${pointer}`, raw, 'refused');
      return;
    }
    const colonSkill = name.startsWith('/skill:') ? name.slice('/skill:'.length) : '';
    const suggestion = colonSkill ? null : suggestRuntimeCommand(commands, name);
    const hint = colonSkill
      ? `Did you mean /skills ${colonSkill}?`
      : suggestion
        ? `Did you mean ${suggestion.name}?`
        : 'Type /help for available commands.';
    options.onError(`Unknown command: ${name}. ${hint}`, raw, 'refused');
    return;
  }
  if (!cmd.validScreens.includes(options.screen)) {
    options.onError(
      `${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`,
      raw,
      'refused',
    );
    return;
  }
  const blocked = cmd.guard?.({
    phase: options.phase,
    plannerSupportsImages: options.plannerSupportsImages,
    openRunAtRest: options.openRunAtRest,
    applyUnfinished: options.applyUnfinished,
    applying: options.applying,
  });
  if (blocked !== undefined) {
    options.onError(blocked, raw, 'refused');
    return;
  }
  if (cmd.kind === 'noarg' && typed !== '') {
    options.onError(`${cmd.name} takes no argument. Usage: ${cmd.name}`, raw, 'refused');
    return;
  }
  let refusal: unknown;
  try {
    refusal = await (cmd.kind === 'arg' ? cmd.handler(typed || undefined) : cmd.handler());
  } catch (err) {
    options.onError(toErrorMessage(err), raw, 'failed');
    return;
  }
  if (typeof refusal === 'string') options.onError(refusal, raw, 'refused');
}
