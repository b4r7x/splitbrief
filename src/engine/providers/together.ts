import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import { createMetadataProvider } from './client/metadata.js';
import { isModelFree, pricingFieldsFromResolved } from './metadata.js';

const TOGETHER_GENERATIVE_TYPES = new Set(['chat', 'language', 'code']);
const DEDICATED_ONLY_DEPLOYMENTS = new Set(['dedicated', 'dedicated-only']);
const SERVERLESS_DEPLOYMENTS = new Set(['serverless']);

const TogetherModelSchema = z.looseObject({
  id: z.string(),
  type: z.string().optional(),
  display_name: z.string().optional(),
  context_length: z.number().int().positive().optional(),
  pricing: z
    .object({
      input: z.number().finite().nonnegative().optional(),
      output: z.number().finite().nonnegative().optional(),
    })
    .optional(),
  deployment: z.string().optional(),
  deployment_type: z.string().optional(),
  dedicated_only: z.boolean().optional(),
  serverless: z.boolean().optional(),
});

type TogetherModel = z.infer<typeof TogetherModelSchema>;

function hasServerlessDeploymentEvidence(model: TogetherModel): boolean {
  if (model.dedicated_only === true || model.serverless === false) return false;

  const deployments = [model.deployment, model.deployment_type].flatMap((deployment) =>
    deployment === undefined ? [] : [deployment.trim().toLowerCase()],
  );
  if (deployments.some((deployment) => DEDICATED_ONLY_DEPLOYMENTS.has(deployment))) return false;

  return (
    model.serverless === true ||
    deployments.some((deployment) => SERVERLESS_DEPLOYMENTS.has(deployment))
  );
}

function isServerlessGenerativeTogetherModel(model: TogetherModel): boolean {
  return (
    model.type !== undefined &&
    TOGETHER_GENERATIVE_TYPES.has(model.type.trim().toLowerCase()) &&
    hasServerlessDeploymentEvidence(model)
  );
}

function extractTogetherModels(data: unknown): TogetherModel[] | null {
  const parsed = z.array(TogetherModelSchema).safeParse(data);
  if (!parsed.success) return null;
  return parsed.data.filter(isServerlessGenerativeTogetherModel);
}

function toDetectedModel(m: TogetherModel): DetectedModel {
  const hasCompletePricing = m.pricing?.input !== undefined && m.pricing?.output !== undefined;
  const result: DetectedModel = {
    id: m.id,
    ...(m.display_name === undefined ? {} : { displayName: m.display_name }),
    ...pricingFieldsFromResolved(
      m.pricing?.input,
      m.pricing?.output,
      hasCompletePricing ? isModelFree(m.pricing?.input, m.pricing?.output) : undefined,
    ),
  };
  if (m.context_length !== undefined) result.contextLength = m.context_length;
  return result;
}

export function createTogetherProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  return createMetadataProvider<TogetherModel>(
    {
      name: 'together',
      defaultBaseURL: getKnownProviderBaseURL('together'),
      envKeyName: 'TOGETHER_API_KEY',
      isLocal: false,
      schema: TogetherModelSchema,
      fallback: (id) => ({ id }),
      toDetected: toDetectedModel,
      contextLength: (m) => m.context_length ?? null,
      extractModels: extractTogetherModels,
    },
    overrides,
  );
}
