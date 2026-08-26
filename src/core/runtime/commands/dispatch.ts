import type { Phase } from '../../schemas/enums.js';
import type { Screen } from '../../navigation/types.js';
import type { RuntimeCommandDef } from './types.js';
import { findRuntimeCommand, removedCommandPointer, suggestRuntimeCommand } from './lookup.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

interface CommandExecutionOptions {
  screen: Screen;
  phase: Phase;
  attached: boolean;
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
  const match = findRuntimeCommand(commands, name);
  if (!match) {
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
  const cmd = match.command;
  if (!cmd.validScreens.includes(options.screen)) {
    options.onError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
    return;
  }
  const blocked = cmd.guard?.({
    phase: options.phase,
    attached: options.attached,
    plannerSupportsImages: options.plannerSupportsImages,
  });
  if (blocked !== undefined) {
    options.onError(blocked);
    return;
  }
  const args = [match.aliasArgs, typed].filter((part) => part).join(' ') || undefined;

  try {
    // biome-ignore lint/nursery/noFloatingPromises: the handler result is awaited here; the rule mis-reads the void | Promise<void> union
    await (cmd.kind === 'arg' ? cmd.handler(args) : cmd.handler());
  } catch (err) {
    options.onError(toErrorMessage(err));
  }
}
