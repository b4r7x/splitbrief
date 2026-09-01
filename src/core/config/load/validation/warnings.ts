import type { Config } from '../../../schemas/config.js';
import type { ImplementerConfig } from '../../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../../schemas/planner-config.js';
import { commandName, isShellEvaluatedPromptArg } from '../../../trust/path-classification.js';
import { configuredReviewerRunner } from '../../accessors/reviewer-runner.js';

const PROMPT_PLACEHOLDER = '{prompt}';

function runnerPromptPlaceholderArgWarnings(
  label: string,
  runner: PlannerConfig | ImplementerConfig,
): string[] {
  if (runner.kind !== 'shell' && runner.kind !== 'agent') return [];
  const args = runner.args ?? [];
  if (!args.some((arg) => arg.includes(PROMPT_PLACEHOLDER))) return [];

  if (isShellEvaluatedPromptArg(runner.command, args)) {
    return [
      `${label}.args passes {prompt} through ${commandName(runner.command)} -c. Placeholder-enabled runs shell-evaluate prompt text there; prefer stdin or a non-shell argv placeholder.`,
    ];
  }

  return [
    `${label}.args contains {prompt}. Placeholder args are allowed, but placeholder-enabled runners pass prompt text through argv; prefer stdin when possible.`,
  ];
}

export function securityWarnings(config: Config): string[] {
  const warnings: string[] = [];
  warnings.push(...runnerPromptPlaceholderArgWarnings('planner', config.planner));
  warnings.push(...runnerPromptPlaceholderArgWarnings('implementer', config.implementer));
  const reviewer = configuredReviewerRunner(config);
  if (reviewer !== undefined) {
    warnings.push(...runnerPromptPlaceholderArgWarnings('reviewer', reviewer));
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles?.profiles ?? {})) {
    warnings.push(...runnerPromptPlaceholderArgWarnings(`implementer profile ${name}`, profile));
  }

  return warnings;
}
