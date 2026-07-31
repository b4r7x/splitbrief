import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OPENAI_COMPAT_STANDARD_FINISH_REASONS,
  type OpenAICompatPolicy,
} from './openai-compat-policy.js';
import type { KnownModel } from '../../core/providers/known-models.js';
import type {
  ApiProviderDescriptor,
  ApiRunnerRole,
} from '../../core/providers/api-provider-catalog.js';
import type { EndpointPolicy } from '../../core/providers/endpoint-policy.js';
import { RunnerBillingPostureSchema } from '../../core/runners/runner-billing.js';
import { isRecord } from '../../utils/type-guards.js';

const CANDIDATE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKSPACE_HOST_PREFIX = '{workspaceId}.';
const MAX_EVIDENCE_OUTPUT_BYTES = 32_768;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\))`,
  'g',
);
const SECRET_ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|access[_-]?token|auth(?:entication)?|password|secret|token)[\s"'=:]+)([^\s,;"'}]+)/gi;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const ABSOLUTE_USER_PATH_PATTERN = /(?:\/(?:Users|home)\/[^\s]+|[A-Za-z]:[\\/]Users[\\/][^\s]+)/g;

const CandidateIdSchema = z
  .string()
  .regex(CANDIDATE_ID_PATTERN, 'candidate id must be lowercase kebab-case');
const EnvNameSchema = z
  .string()
  .regex(ENV_NAME_PATTERN, 'credential env must be an upper-case environment name');
const AsOfSchema = z.string().regex(DATE_PATTERN, 'asOf must be an ISO date');
const RunnerRoleSchema = z.enum(['planner', 'implementer']);
const ApiOfferingSchema = z.enum(['payg', 'free-quota', 'coding-subscription', 'local']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isFixedOrigin(value: string): boolean {
  const parsed = parseUrl(value);
  return (
    parsed !== null &&
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    parsed.search === '' &&
    parsed.hash === ''
  );
}

function isLoopback(value: string): boolean {
  const parsed = parseUrl(value);
  if (
    parsed === null ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return false;
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '[::1]') return true;
  const octets = parsed.hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  );
}

function isHostDeclaration(value: string): boolean {
  const declaration = value.startsWith(WORKSPACE_HOST_PREFIX)
    ? value.slice(WORKSPACE_HOST_PREFIX.length)
    : value;
  return (
    declaration.length > 0 &&
    declaration.length <= 253 &&
    declaration.split('.').every((label) => HOST_LABEL_PATTERN.test(label))
  );
}

function isPathSuffix(value: string): boolean {
  if (
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\')
  ) {
    return false;
  }
  const parsed = parseUrl(`https://candidate.invalid${value}`);
  return parsed !== null && parsed.pathname === value;
}

function isStandardFinishReason(value: string): boolean {
  return OPENAI_COMPAT_STANDARD_FINISH_REASONS.some((reason) => reason === value);
}

const FixedOriginEndpointSchema = z
  .strictObject({ kind: z.literal('fixed-origin'), baseURL: z.string().min(1) })
  .refine((value) => isFixedOrigin(value.baseURL), {
    path: ['baseURL'],
    message: 'fixed-origin must be an HTTPS origin without credentials, query, or fragment',
  });

const AllowedHttpsEndpointSchema = z
  .strictObject({
    kind: z.literal('allowed-https'),
    hosts: z.array(z.string().min(1)).min(1).readonly(),
    pathSuffix: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.hosts.some((host) => !isHostDeclaration(host))) {
      ctx.addIssue({
        code: 'custom',
        path: ['hosts'],
        message: 'hosts contain an invalid declaration',
      });
    }
    if (!isPathSuffix(value.pathSuffix)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pathSuffix'],
        message: 'pathSuffix must be an exact URL path',
      });
    }
  });

const LoopbackEndpointSchema = z
  .strictObject({ kind: z.literal('loopback'), defaultBaseURL: z.string().min(1) })
  .refine((value) => isLoopback(value.defaultBaseURL), {
    path: ['defaultBaseURL'],
    message: 'loopback defaultBaseURL must use localhost, 127.0.0.1, or ::1',
  });

export const EndpointPolicySchema = z.discriminatedUnion('kind', [
  FixedOriginEndpointSchema,
  AllowedHttpsEndpointSchema,
  LoopbackEndpointSchema,
]);
export type CandidateEndpointPolicy = z.infer<typeof EndpointPolicySchema>;

const RawRequestSchema = z
  .strictObject({
    stream: z.boolean(),
    includeUsage: z.boolean(),
    tokenField: z.enum(['max_tokens', 'max_completion_tokens']),
    max: z.number().int().positive(),
    temperature: z.number().finite().optional(),
    effort: z.enum(['omit', 'verbatim', 'clamp-xhigh', 'map-medium-to-high']).optional(),
    reasoning: z.enum(['omit', 'reasoning_effort']).optional(),
    extraBody: z.record(z.string(), z.unknown()).optional(),
    finishReasons: z.array(z.string().min(1)).min(1).readonly().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.finishReasons?.some((reason) => !isStandardFinishReason(reason))) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishReasons'],
        message: 'rawRequest finishReasons must use the canonical standard reasons',
      });
    }
  });

const RawProviderCandidateShape = {
  id: CandidateIdSchema,
  service: z.string().min(1),
  offering: ApiOfferingSchema,
  roles: z
    .array(RunnerRoleSchema)
    .min(1)
    .refine((roles) => new Set(roles).size === roles.length, 'roles must not contain duplicates')
    .readonly(),
  endpointPolicy: EndpointPolicySchema,
  credentialEnv: EnvNameSchema.nullable().optional(),
  credentialPrefix: z.string().min(1).nullable().optional(),
  modelIds: z.array(z.string().min(1)).readonly(),
  rawRequest: RawRequestSchema,
  expectedRawTerminal: z.string().min(1),
  asOf: AsOfSchema,
};

export const RawProviderCandidateContract = z
  .strictObject(RawProviderCandidateShape)
  .superRefine((value, ctx) => {
    if (
      value.offering !== 'local' &&
      (value.credentialEnv === undefined || value.credentialEnv === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialEnv'],
        message: 'remote candidates require a named credential environment variable',
      });
    }
    if (value.endpointPolicy.kind === 'allowed-https') {
      const expected = baseUrlEnvironmentName(value.id);
      if (!ENV_NAME_PATTERN.test(expected)) {
        ctx.addIssue({
          code: 'custom',
          path: ['id'],
          message: 'candidate id cannot derive a base URL environment name',
        });
      }
    }
  });
export type RawProviderCandidateContract = z.infer<typeof RawProviderCandidateContract>;
export const RawProviderCandidateContractSchema = RawProviderCandidateContract;

const ApiProviderDescriptorSchema = z
  .strictObject({
    id: CandidateIdSchema,
    service: z.string().min(1),
    offering: ApiOfferingSchema,
    roles: z
      .array(RunnerRoleSchema)
      .min(1)
      .refine((roles) => new Set(roles).size === roles.length, 'roles must not contain duplicates')
      .readonly(),
    endpointPolicy: EndpointPolicySchema,
    credentialEnv: EnvNameSchema.nullable(),
    credentialPrefix: z.string().min(1).nullable(),
    billing: RunnerBillingPostureSchema,
    compatibility: z.enum(['verified', 'unverified', 'incompatible', 'beta', 'unknown']),
    dataUse: z.enum([
      'local',
      'non-retention',
      'no-training',
      'opt-out',
      'region-sensitive',
      'provider-routed',
      'allowed-training',
      'unreviewed',
    ]),
    privacyURL: z.string().url(),
    termsURL: z.string().url(),
    asOf: AsOfSchema,
  })
  .superRefine((value, ctx) => {
    if (value.offering !== 'local' && value.credentialEnv === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialEnv'],
        message: 'remote descriptors require credentials',
      });
    }
  });

const KnownModelSchema = z.strictObject({
  name: z.string().min(1),
  isDefault: z.boolean().optional(),
  contextLength: z.number().int().positive().optional(),
  pricingInput: z.number().finite().nonnegative().optional(),
  pricingOutput: z.number().finite().nonnegative().optional(),
  pricingCacheRead: z.number().finite().nonnegative().optional(),
  pricingCacheWrite: z.number().finite().nonnegative().optional(),
  isFree: z.boolean().optional(),
  aliases: z.array(z.string().min(1)).readonly().optional(),
  provenance: z.string().min(1).optional(),
});

function isOpenAICompatPolicy(value: unknown): value is OpenAICompatPolicy {
  if (!isRecord(value)) return false;
  const finishReasons = value.finishReasons;
  return (
    (value.tokenField === 'max_tokens' || value.tokenField === 'max_completion_tokens') &&
    typeof value.streamUsage === 'boolean' &&
    (value.temperature === 'omit' || value.temperature === 'verbatim') &&
    (value.effort === 'omit' ||
      value.effort === 'verbatim' ||
      value.effort === 'clamp-xhigh' ||
      value.effort === 'map-medium-to-high') &&
    (value.reasoning === 'omit' || value.reasoning === 'reasoning_effort') &&
    (value.extraBody === undefined || isRecord(value.extraBody)) &&
    Array.isArray(finishReasons) &&
    finishReasons.length > 0 &&
    finishReasons.every((reason) => typeof reason === 'string' && isStandardFinishReason(reason))
  );
}

const OpenAICompatPolicySchema = z.custom<OpenAICompatPolicy>(isOpenAICompatPolicy, {
  message: 'policy must be a canonical OpenAI-compatible policy',
});

export const UnregisteredProviderCandidate = z
  .strictObject({
    rawContract: RawProviderCandidateContract,
    descriptor: ApiProviderDescriptorSchema,
    knownModels: z.array(KnownModelSchema),
    policy: OpenAICompatPolicySchema,
  })
  .superRefine((candidate, ctx) => {
    if (candidate.descriptor.id !== candidate.rawContract.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'id'],
        message: 'descriptor id must match raw contract id',
      });
    }
    if (candidate.descriptor.service !== candidate.rawContract.service) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'service'],
        message: 'descriptor service must match raw contract service',
      });
    }
    if (candidate.descriptor.offering !== candidate.rawContract.offering) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'offering'],
        message: 'descriptor offering must match raw contract offering',
      });
    }
    if (
      canonicalJson(candidate.descriptor.endpointPolicy) !==
      canonicalJson(candidate.rawContract.endpointPolicy)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'endpointPolicy'],
        message: 'descriptor endpoint policy must match raw contract endpoint policy',
      });
    }
    const rawCredentialEnv = candidate.rawContract.credentialEnv ?? null;
    if (candidate.descriptor.credentialEnv !== rawCredentialEnv) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'credentialEnv'],
        message: 'descriptor credential environment must match raw contract credential environment',
      });
    }
    const rawCredentialPrefix = candidate.rawContract.credentialPrefix ?? null;
    if (candidate.descriptor.credentialPrefix !== rawCredentialPrefix) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'credentialPrefix'],
        message: 'descriptor credential prefix must match raw contract credential prefix',
      });
    }
    for (const role of candidate.rawContract.roles) {
      if (!candidate.descriptor.roles.includes(role)) {
        ctx.addIssue({
          code: 'custom',
          path: ['descriptor', 'roles'],
          message: `descriptor is missing ${role} role`,
        });
      }
    }
    if (candidate.rawContract.modelIds.length > 0) {
      const knownNames = new Set(
        candidate.knownModels.flatMap((model) => [model.name, ...(model.aliases ?? [])]),
      );
      for (const modelId of candidate.rawContract.modelIds) {
        if (!knownNames.has(modelId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['knownModels'],
            message: `knownModels is missing ${modelId}`,
          });
        }
      }
    }
  });
export type UnregisteredProviderCandidate = z.infer<typeof UnregisteredProviderCandidate>;
export const UnregisteredProviderCandidateSchema = UnregisteredProviderCandidate;

export type CandidateEvidenceRole = ApiRunnerRole;

const ContractHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'contractSha256 must be lowercase SHA-256');
const CandidateEvidenceCaptureSchema = z.strictObject({
  candidateId: CandidateIdSchema,
  role: RunnerRoleSchema,
  contractSha256: ContractHashSchema,
  stdout: z
    .string()
    .max(MAX_EVIDENCE_OUTPUT_BYTES)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_EVIDENCE_OUTPUT_BYTES, {
      message: 'stdout exceeds the evidence byte budget',
    })
    .refine((value) => !hasUnsanitizedCandidateOutput(value), {
      message: 'stdout must be sanitized before it is recorded',
    }),
  stderr: z
    .string()
    .max(MAX_EVIDENCE_OUTPUT_BYTES)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_EVIDENCE_OUTPUT_BYTES, {
      message: 'stderr exceeds the evidence byte budget',
    })
    .refine((value) => !hasUnsanitizedCandidateOutput(value), {
      message: 'stderr must be sanitized before it is recorded',
    }),
});

function hasUnsanitizedCandidateOutput(value: string): boolean {
  const sanitizedMarkersRemoved = value.replaceAll('[REDACTED]', '');
  const patterns = [
    ANSI_ESCAPE_PATTERN,
    BEARER_PATTERN,
    SECRET_ASSIGNMENT_PATTERN,
    ABSOLUTE_USER_PATH_PATTERN,
  ];
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(sanitizedMarkersRemoved);
  });
}

export const CandidateEvidence = z
  .strictObject({
    rawCapture: CandidateEvidenceCaptureSchema,
    productionConformance: CandidateEvidenceCaptureSchema.nullable(),
    verdict: z.enum(['PASS', 'OMIT']),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.verdict === 'PASS' && evidence.productionConformance === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['productionConformance'],
        message: 'PASS requires production conformance evidence',
      });
    }
    if (
      evidence.productionConformance !== null &&
      (evidence.productionConformance.candidateId !== evidence.rawCapture.candidateId ||
        evidence.productionConformance.role !== evidence.rawCapture.role ||
        evidence.productionConformance.contractSha256 !== evidence.rawCapture.contractSha256)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['productionConformance'],
        message: 'production evidence identity must match raw capture',
      });
    }
  });
export type CandidateEvidence = z.infer<typeof CandidateEvidence>;
export const CandidateEvidenceSchema = CandidateEvidence;

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isRecord(value)) {
    const fields = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(',')}}`;
  }
  return 'null';
}

export function contractSha256(contract: unknown): string {
  return createHash('sha256').update(canonicalJson(contract), 'utf8').digest('hex');
}

export const canonicalContractSha256 = contractSha256;

export function baseUrlEnvironmentName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_BASE_URL`;
}

export function requiresLiveModelDiscovery(
  contract: Pick<RawProviderCandidateContract, 'modelIds'>,
): boolean {
  return contract.modelIds.length === 0;
}

export function sanitizeCandidateOutput(
  value: string,
  maxBytes = MAX_EVIDENCE_OUTPUT_BYTES,
): string {
  const redacted = value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(BEARER_PATTERN, '[REDACTED]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(ABSOLUTE_USER_PATH_PATTERN, '/[PATH]');
  return Buffer.byteLength(redacted, 'utf8') <= maxBytes
    ? redacted
    : `${Buffer.from(redacted, 'utf8').subarray(0, maxBytes).toString('utf8')}…`;
}

export function createCandidateEvidenceCapture(input: {
  candidateId: string;
  role: CandidateEvidenceRole;
  contractSha256: string;
  stdout?: string;
  stderr?: string;
}): CandidateEvidence['rawCapture'] {
  return {
    candidateId: CandidateIdSchema.parse(input.candidateId),
    role: RunnerRoleSchema.parse(input.role),
    contractSha256: ContractHashSchema.parse(input.contractSha256),
    stdout: sanitizeCandidateOutput(input.stdout ?? ''),
    stderr: sanitizeCandidateOutput(input.stderr ?? ''),
  };
}

export function normalizeCandidateEvidence(input: {
  rawCapture: Parameters<typeof createCandidateEvidenceCapture>[0];
  productionConformance?: Parameters<typeof createCandidateEvidenceCapture>[0] | null;
  verdict: 'PASS' | 'OMIT';
}): CandidateEvidence {
  return CandidateEvidence.parse({
    rawCapture: createCandidateEvidenceCapture(input.rawCapture),
    productionConformance:
      input.productionConformance === undefined || input.productionConformance === null
        ? null
        : createCandidateEvidenceCapture(input.productionConformance),
    verdict: input.verdict,
  });
}

export type {
  ApiProviderDescriptor,
  ApiRunnerRole,
  EndpointPolicy,
  KnownModel,
  OpenAICompatPolicy,
};
