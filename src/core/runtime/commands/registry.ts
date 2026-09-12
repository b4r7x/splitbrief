import type { RuntimeCommandDef, RuntimeCommandContext } from './types.js';
import { navigateCommands } from './defs/navigate.js';
import { crewCommands } from './defs/crew.js';
import { workflowCommands } from './defs/workflow.js';
import { viewCommands } from './defs/view.js';
import { ioCommands } from './defs/io.js';

// Concatenated in COMMAND_CATEGORIES order, which is also the order help and the palette render.
export function createRuntimeCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  return [
    ...navigateCommands(ctx),
    ...crewCommands(ctx),
    ...workflowCommands(ctx),
    ...viewCommands(ctx),
    ...ioCommands(ctx),
  ];
}
