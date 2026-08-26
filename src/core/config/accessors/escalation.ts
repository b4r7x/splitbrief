import type { Config } from '../../schemas/config.js';
import type { ProviderId } from '../../schemas/enums.js';

export type ApiRunnerConfig = Readonly<{
  kind: 'api';
  provider: string;
  model: string;
}>;

export function readEscalationRunner(config: Config): ApiRunnerConfig | undefined {
  if (config.escalation?.enabled === false) return undefined;
  const provider = config.escalation?.intermediateProvider;
  const model = config.escalation?.intermediateModel;
  if (provider === undefined || model === undefined) return undefined;
  return { kind: 'api', provider, model };
}

export function writeEscalationRunner(
  config: Config,
  input: Readonly<{ provider: ProviderId; model: string }>,
): Config {
  return {
    ...config,
    escalation: {
      ...config.escalation,
      intermediateProvider: input.provider,
      intermediateModel: input.model,
      enabled: true,
    },
  };
}

export function clearEscalation(config: Config): Config {
  if (config.escalation === undefined) return config;
  const escalation = { ...config.escalation };
  delete escalation.intermediateProvider;
  delete escalation.intermediateModel;
  return { ...config, escalation };
}
