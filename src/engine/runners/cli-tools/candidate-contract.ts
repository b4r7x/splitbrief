import { z } from 'zod';
import type {
  CliImplementerBuildArgsInput,
  CliOutputContract,
  CliPlannerBuildArgsInput,
  CliProbeContract,
  CliPromptTransport,
  CliPromptEncoder,
  CliProtocolEvent,
  CliTerminalInput,
} from './contract.js';
import { CandidateEvidence, contractSha256 } from '../../providers/candidate-contract.js';
import { isRecord } from '../../../utils/type-guards.js';

export const CLI_PROMPT_SENTINEL = '<PROMPT>' as const;
/** Stands for the staged project's absolute path, for a tool that does not resolve a relative one. */
export const CLI_PROJECT_DIR_SENTINEL = '<PROJECT_DIR>' as const;

const CANDIDATE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ANGLE_PLACEHOLDER_PATTERN = /<[^>]*>/;
const CURLY_PROMPT_PATTERN = /\{prompt\}/i;
const RunnerRoleSchema = z.enum(['planner', 'implementer']);

const CandidateIdSchema = z
  .string()
  .regex(CANDIDATE_ID_PATTERN, 'candidate id must be lowercase kebab-case');
const EnvNameSchema = z
  .string()
  .regex(ENV_NAME_PATTERN, 'auth env must be an upper-case environment name');

const CliAuthSchema = z.strictObject({
  kind: z.string().min(1),
  env: z.array(EnvNameSchema).readonly(),
});

function hasPlaceholder(value: string): boolean {
  return ANGLE_PLACEHOLDER_PATTERN.test(value) || CURLY_PROMPT_PATTERN.test(value);
}

function hasPromptPlaceholder(rawInvocation: readonly string[]): boolean {
  return rawInvocation.some((arg) => arg !== CLI_PROJECT_DIR_SENTINEL && hasPlaceholder(arg));
}

const RawCliCandidateShape = {
  id: CandidateIdSchema,
  command: z
    .string()
    .min(1)
    .refine((command) => !/\s/.test(command), 'command must be one executable token'),
  role: RunnerRoleSchema,
  versionArgs: z.array(z.string()).min(1).readonly(),
  auth: CliAuthSchema,
  rawInvocation: z.array(z.string()).readonly(),
  promptTransport: z.literal('stdin'),
  expectedRawTerminal: z.string().min(1),
  asOf: z.string().regex(DATE_PATTERN, 'asOf must be an ISO date'),
};

export const RawCliCandidateContract = z
  .strictObject(RawCliCandidateShape)
  .superRefine((contract, ctx) => {
    if (hasPromptPlaceholder(contract.rawInvocation)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawInvocation'],
        message: 'stdin transport must not contain a prompt placeholder',
      });
    }
  });
export type RawCliCandidateContract = z.infer<typeof RawCliCandidateContract>;

type CliArgumentValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; conflicts: readonly string[] }>;

type UnregisteredCliAdapterCommon = Readonly<{
  descriptor: Readonly<{ id: string }>;
  promptTransport: CliPromptTransport;
  encodePrompt?: CliPromptEncoder | undefined;
  validateArgs: (input: {
    invocationArgs: readonly string[];
    baseArgs: readonly string[];
  }) => CliArgumentValidation;
  environment: Readonly<Record<string, string>>;
  outputContract: CliOutputContract;
  parse: (line: string) => readonly CliProtocolEvent[];
  terminal: (input: CliTerminalInput) => Extract<CliProtocolEvent, { type: 'result' }>;
  probe: CliProbeContract;
}>;

export type UnregisteredCliAdapter =
  | (UnregisteredCliAdapterCommon &
      Readonly<{
        role: 'planner';
        buildArgs: (input: CliPlannerBuildArgsInput) => readonly string[];
      }>)
  | (UnregisteredCliAdapterCommon &
      Readonly<{
        role: 'implementer';
        buildArgs: (input: CliImplementerBuildArgsInput) => readonly string[];
      }>);

function isCompleteCliAdapter(value: unknown): value is UnregisteredCliAdapter {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.descriptor) &&
    typeof value.descriptor.id === 'string' &&
    (value.role === 'planner' || value.role === 'implementer') &&
    isRecord(value.promptTransport) &&
    value.promptTransport.kind === 'stdin' &&
    typeof value.buildArgs === 'function' &&
    typeof value.validateArgs === 'function' &&
    isRecord(value.environment) &&
    isRecord(value.outputContract) &&
    typeof value.parse === 'function' &&
    typeof value.terminal === 'function' &&
    isRecord(value.probe)
  );
}

const CompleteCliAdapterSchema = z.custom<UnregisteredCliAdapter>(isCompleteCliAdapter, {
  message: 'candidate adapter must expose the complete CLI contract',
});

const UnregisteredCliCandidateShape = {
  id: CandidateIdSchema,
  role: RunnerRoleSchema,
  rawContract: RawCliCandidateContract,
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/, 'contractSha256 must be lowercase SHA-256'),
  adapter: CompleteCliAdapterSchema,
};

export const UnregisteredCliCandidate = z
  .strictObject(UnregisteredCliCandidateShape)
  .superRefine((candidate, ctx) => {
    if (candidate.rawContract.id !== candidate.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawContract', 'id'],
        message: 'raw contract id must match candidate id',
      });
    }
    if (candidate.rawContract.role !== candidate.role) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawContract', 'role'],
        message: 'raw contract role must match candidate role',
      });
    }
    if (candidate.adapter.role !== candidate.role) {
      ctx.addIssue({
        code: 'custom',
        path: ['adapter', 'role'],
        message: 'adapter role must match candidate role',
      });
    }
    if (candidate.adapter.descriptor.id !== candidate.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['adapter', 'descriptor', 'id'],
        message: 'adapter descriptor id must match candidate id',
      });
    }
    const expectedHash = contractSha256(candidate.rawContract);
    if (candidate.contractSha256 !== expectedHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['contractSha256'],
        message: 'contractSha256 does not match canonical raw contract JSON',
      });
    }
  });
export type UnregisteredCliCandidate = z.infer<typeof UnregisteredCliCandidate>;

export const CliConformanceCandidatesSchema = z
  .array(UnregisteredCliCandidate)
  .superRefine((candidates, ctx) => {
    const identities = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      const identity = `${candidate.id}:${candidate.role}`;
      if (identities.has(identity)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'candidate array contains a duplicate tool/role entry',
        });
      }
      identities.add(identity);
    }
  });

export function parseCliConformanceCandidates(value: unknown): readonly UnregisteredCliCandidate[] {
  return CliConformanceCandidatesSchema.parse(value);
}

export function replaceProjectDirSentinel(
  rawInvocation: readonly string[],
  projectDir: string,
): readonly string[] {
  return rawInvocation.map((argument) =>
    argument === CLI_PROJECT_DIR_SENTINEL ? projectDir : argument,
  );
}

export function candidateEvidenceWithCliCapture(
  rawCapture: CandidateEvidence['rawCapture'],
  productionConformance: CandidateEvidence['productionConformance'],
  verdict: CandidateEvidence['verdict'],
): CandidateEvidence {
  return CandidateEvidence.parse({ rawCapture, productionConformance, verdict });
}
