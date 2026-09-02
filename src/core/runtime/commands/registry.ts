import type { RuntimeCommandDef, RuntimeCommandContext } from './types.js';
import { navigateCommands } from './defs/navigate.js';
import { crewCommands } from './defs/crew.js';
import { workflowCommands } from './defs/workflow.js';
import { viewCommands } from './defs/view.js';
import { ioCommands } from './defs/io.js';

// Attached TUI clients drive a detached server over IPC. Keep only local-view commands and commands
// with explicit IPC handling; config/workflow mutations would otherwise report success while
// changing only the attached client.
export const ATTACHED_AVAILABLE_COMMANDS = new Set<string>([
  '/help',
  '/palette',
  '/sessions',
  '/copy',
  '/home',
  '/scroll',
  '/activity',
  '/sidebar',
  '/queue',
  '/quit',
]);

// Concatenated in COMMAND_CATEGORIES order, which is also the order help and the palette render.
export function createRuntimeCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  const commands = [
    ...navigateCommands(ctx),
    ...crewCommands(ctx),
    ...workflowCommands(ctx),
    ...viewCommands(ctx),
    ...ioCommands(ctx),
  ];

  if (ctx.isAttached) {
    return commands.filter((cmd) => ATTACHED_AVAILABLE_COMMANDS.has(cmd.name));
  }
  return commands;
}
