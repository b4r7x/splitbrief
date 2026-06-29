import {
  getRunnerDisplayName,
  getRunnerModelName,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import { formatModelName } from '../../../core/model-display.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';

export function runnerShortLabel(runner: RunnerConfig): string {
  const model = getRunnerModelName(runner);
  const raw = model ? formatModelName(model) : getRunnerDisplayName(runner);
  return sanitizeTerminalDisplayText(raw);
}
