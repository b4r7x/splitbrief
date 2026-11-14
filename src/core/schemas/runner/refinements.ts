import type { z } from 'zod';
import { narrowRecord, includes } from '../../../utils/type-guards.js';
import { normalizeConfiguredModel, isAutomaticModel } from '../../providers/automatic-model.js';
import { hasAutomaticModelDefault } from '../../providers/model-selection.js';
import { isOllamaLocalCredentialReference } from '../../providers/ollama-credential.js';
import {
  CLI_TOOL_CATALOG,
  cliModelPolicyViolations,
  isCliToolId,
} from '../../runners/cli-tool/catalog.js';
import type { RunnerRole } from '../../runners/seat-roles.js';
import {
  REMOVED_API_PROVIDER_IDS,
  descriptorsForProviderIdentity,
  API_PROVIDER_DESCRIPTORS,
} from './fields.js';

export function validateAutomaticModelResolvable(input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (!runner) return;

  const model = typeof runner.model === 'string' ? runner.model : undefined;
  if (model !== undefined && normalizeConfiguredModel(model) === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['model'],
      message: 'model must be a model ID or "auto"',
    });
    return;
  }

  if (runner.kind !== 'api' || typeof runner.provider !== 'string') return;
  const automatic = runner.model === undefined || isAutomaticModel(model);
  if (!automatic || hasAutomaticModelDefault(runner.provider)) return;

  const spelling = runner.model === undefined ? 'an omitted model' : 'model "auto"';
  ctx.addIssue({
    code: 'custom',
    path: ['model'],
    message: `${spelling} cannot be resolved for API provider "${runner.provider}" — it has no catalog default; set an explicit model ID`,
  });
}

export function validateOllamaLocalCredential(input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (runner?.kind !== 'api' || runner.provider !== 'ollama') return;

  const apiKey = typeof runner.apiKey === 'string' ? runner.apiKey : undefined;
  if (isOllamaLocalCredentialReference(apiKey)) return;

  ctx.addIssue({
    code: 'custom',
    path: ['apiKey'],
    message:
      'Local Ollama apiKey must be omitted or exactly "env:OLLAMA_LOCAL_API_KEY" to keep cloud credentials out of loopback requests',
  });
}

// A removed provider still satisfies the custom-provider escape hatch, so
// without this it would load as an anonymous endpoint under its old name.
export function validateRemovedApiProvider(input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (runner?.kind !== 'api' || typeof runner.provider !== 'string') return;
  if (!includes(REMOVED_API_PROVIDER_IDS, runner.provider.toLowerCase())) return;

  ctx.addIssue({
    code: 'custom',
    path: ['provider'],
    message: `API provider "${runner.provider}" was removed. Configure it as a custom endpoint: set provider/service to your own name plus apiBase and an inline apiKey (docs/CONFIGURATION.md).`,
  });
}

export function validateApiIdentity(input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (
    runner?.kind !== 'api' ||
    typeof runner.provider !== 'string' ||
    typeof runner.service !== 'string' ||
    typeof runner.offering !== 'string'
  ) {
    return;
  }

  const providerCandidates = descriptorsForProviderIdentity(runner.provider);
  if (
    providerCandidates.length > 0 &&
    !providerCandidates.some(
      (candidate) => candidate.service === runner.service && candidate.offering === runner.offering,
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['offering'],
      message: `API provider "${runner.provider}" does not match service "${runner.service}" with offering "${runner.offering}"`,
    });
    return;
  }

  const serviceCandidates = API_PROVIDER_DESCRIPTORS.filter(
    (descriptor) => descriptor.service === runner.service,
  );
  if (
    serviceCandidates.length > 0 &&
    !serviceCandidates.some((candidate) => candidate.offering === runner.offering)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['offering'],
      message: `API service "${runner.service}" does not provide offering "${runner.offering}"`,
    });
  }
}

export function validateCliModelPolicy(
  role: RunnerRole,
  input: unknown,
  ctx: z.RefinementCtx,
): void {
  const runner = narrowRecord(input);
  if (runner?.kind !== 'cli' || typeof runner.tool !== 'string') return;

  const descriptor = Object.values(CLI_TOOL_CATALOG).find(({ id }) => id === runner.tool);
  if (descriptor === undefined) return;

  const selection = {
    model: typeof runner.model === 'string' ? runner.model : undefined,
    customModels: Array.isArray(runner.customModels)
      ? runner.customModels.filter((model): model is string => typeof model === 'string')
      : undefined,
  };
  for (const violation of cliModelPolicyViolations(descriptor.modelPolicy[role], selection)) {
    ctx.addIssue({
      code: 'custom',
      path: [violation.field],
      message: violation.message,
    });
  }
}

function cliToolTakesEffortAsVariant(tool: unknown): boolean {
  if (typeof tool !== 'string' || !isCliToolId(tool)) return false;
  return CLI_TOOL_CATALOG[tool].effortChannel === 'variant';
}

/**
 * A declared fallback is a cli runner the seat has to be able to host, so it is
 * re-parsed through the seat's own cli branch: a tool the seat cannot run, a
 * model its policy refuses or an effort its channel cannot carry all fail here,
 * with the issue kept under `fallback` so the reader knows which block to fix.
 */
export function validateFallback(cliSeat: z.ZodType, input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  const fallback = runner === null ? null : narrowRecord(runner.fallback);
  if (fallback === null) return;

  const parsed = cliSeat.safeParse({ kind: 'cli', ...fallback });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: ['fallback', ...issue.path],
        message: `fallback ${issue.message}`,
      });
    }
    return;
  }

  if (fallback.effort !== undefined && cliToolTakesEffortAsVariant(fallback.tool)) {
    ctx.addIssue({
      code: 'custom',
      path: ['fallback', 'effort'],
      message: `fallback tool "${String(fallback.tool)}" takes its effort as a variant; set fallback.variant instead`,
    });
  }
}
