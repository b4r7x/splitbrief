import type { Phase } from '../../schemas/enums.js';
import type { Screen } from '../../navigation/types.js';
import type { RuntimeCommandDef } from './types.js';
import { findRuntimeCommand, removedCommandPointer, suggestRuntimeCommand } from './lookup.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

interface CommandExecutionOptions {
  screen: Screen;
  phase: Phase;
  plannerSupportsImages: boolean;
  onError: (msg: string) => void;
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
      options.onError(`${name} was removed: ${pointer}`);
      return;
    }
    const suggestion = suggestRuntimeCommand(commands, name);
    const hint = suggestion
      ? `Did you mean ${suggestion.name}?`
      : 'Type /help for available commands.';
    options.onError(`Unknown command: ${name}. ${hint}`);
    return;
  }
  if (!cmd.validScreens.includes(options.screen)) {
    options.onError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
    return;
  }
  const blocked = cmd.guard?.({
    phase: options.phase,
    plannerSupportsImages: options.plannerSupportsImages,
  });
  if (blocked !== undefined) {
    options.onError(blocked);
    return;
  }
  try {
    // biome-ignore lint/nursery/noFloatingPromises: the handler result is awaited here; the rule mis-reads the void | Promise<void> union
    await (cmd.kind === 'arg' ? cmd.handler(typed || undefined) : cmd.handler());
  } catch (err) {
    options.onError(toErrorMessage(err));
  }
}
