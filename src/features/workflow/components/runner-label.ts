import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import {
  getRunnerCatalogDisplayName,
  getRunnerModelName,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import { formatModelName } from '../../../core/model-display.js';
import type { Config } from '../../../core/schemas/config.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';

export function runnerShortLabel(runner: RunnerConfig): string {
  const model = getRunnerModelName(runner);
  const raw = model ? formatModelName(model) : getRunnerCatalogDisplayName(runner);
  return sanitizeTerminalDisplayText(raw);
}

export function reviewerSeatLabel(config: Config | null | undefined): string {
  const reviewer = configuredReviewerRunner(config);
  return reviewer ? runnerShortLabel(reviewer) : '';
}
