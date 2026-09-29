import { resolveMode } from '../../../core/config/runtime/resolve.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';

/**
 * The mode the run on screen is on. The engine's resolved mode leads — a live `mode_resolved`
 * event, or the mode a run at rest was settled with — then the mode the navigation record kept,
 * which is all a fresh run has until the engine resolves. A fresh run's local execution still
 * holds the config it was prepared with, so that config answers before the store's mutable one:
 * a `/mode … for the next run` write cannot repaint a started run's rail, footer or sidebar even
 * during the window before the engine publishes `mode_resolved`.
 */
export function resolveRunMode(input: {
  resolvedMode: WorkflowMode | null;
  savedMode: WorkflowMode | null;
  preparedConfig: Config | null;
  config: Config | null;
}): WorkflowMode | null {
  if (input.resolvedMode !== null) return input.resolvedMode;
  if (input.savedMode !== null) return input.savedMode;
  if (input.preparedConfig !== null) return resolveMode({ config: input.preparedConfig });
  return input.config === null ? null : resolveMode({ config: input.config });
}
