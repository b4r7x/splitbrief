import type { Phase } from '../../schemas/enums.js';
import type { Screen } from '../../navigation/types.js';
import type { RuntimeCommandDef } from './types.js';
import { lookupRuntimeCommand } from './lookup.js';

interface CommandExecutionOptions {
  screen: Screen;
  phase: Phase;
  onError: (msg: string) => void;
}

export async function executeRuntimeCommand(
  commands: RuntimeCommandDef[],
  raw: string,
  options: CommandExecutionOptions,
): Promise<void> {
  const parts = raw.split(' ');
  const name = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).join(' ').trim() || undefined;
  const cmd = lookupRuntimeCommand(commands, name);
  if (!cmd) {
    options.onError(`Unknown command: ${name}. Type /help for available commands.`);
    return;
  }
  if (!cmd.validScreens.includes(options.screen)) {
    options.onError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
    return;
  }
  if (cmd.phaseGuard && !cmd.phaseGuard(options.phase)) {
    options.onError(`${cmd.name} is not available during the ${options.phase} phase.`);
    return;
  }

  try {
    if (cmd.kind === 'arg') await cmd.handler(args);
    else await cmd.handler();
  } catch (err) {
    options.onError(err instanceof Error ? err.message : String(err));
  }
}
