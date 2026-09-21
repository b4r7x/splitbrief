import { z } from 'zod';
import { RunnerBillingPostureSchema } from '../runners/runner-billing.js';

/**
 * A static adapter or matrix entry id (`CliAuthEnforcementEvidence.id`), never
 * text lifted from tool output: no whitespace, slashes, `@`, `?` or `:`.
 */
const EvidenceIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

/**
 * A non-reversible digest of the connection, `<label>:<hex digest>`, so a raw
 * endpoint, its userinfo or query, or a credential cannot be stored in its place.
 */
const ConnectionKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]{0,31}:[a-f0-9]{16,64}$/);

const RunnerIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const ModelSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S+$/)
  .refine((model) => !model.includes('://'), 'model must not be an endpoint URL');

const InvocationChannelSchema = z.enum(['session', 'api-key', 'none']);

const ChannelEvidenceSchema = z.strictObject({
  channel: InvocationChannelSchema,
  evidenceId: EvidenceIdSchema,
});

export const InvocationIdentitySchema = z
  .strictObject({
    version: z.literal(1),
    capturedAt: z.number().int().nonnegative(),
    runner: z.strictObject({
      kind: z.enum(['cli', 'api', 'shell', 'agent']),
      id: RunnerIdSchema.optional(),
    }),
    model: ModelSchema.optional(),
    connectionKey: ConnectionKeySchema.optional(),
    configuredChannel: z.enum(['session', 'api-key', 'provider-dependent', 'none']).optional(),
    observedChannel: ChannelEvidenceSchema.optional(),
    enforcedChannel: ChannelEvidenceSchema.optional(),
    billing: z.strictObject({
      posture: RunnerBillingPostureSchema,
      basis: z.enum(['unknown', 'enforced-channel', 'observed-invocation', 'local-transport']),
      evidenceId: EvidenceIdSchema.optional(),
    }),
  })
  .superRefine((identity, ctx) => {
    const { billing, observedChannel, enforcedChannel } = identity;
    const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['billing'], message });

    if (billing.basis === 'unknown') {
      if (billing.posture !== 'unknown') issue('an unknown billing basis bills as unknown');
      if (billing.evidenceId !== undefined) issue('an unknown billing basis carries no evidence');
      return;
    }
    if (billing.posture === 'unknown') issue('a proven billing basis names its posture');
    if (billing.evidenceId === undefined) {
      issue('a proven billing basis names its evidence');
      return;
    }
    if (
      observedChannel !== undefined &&
      enforcedChannel !== undefined &&
      observedChannel.channel !== enforcedChannel.channel
    ) {
      issue('conflicting observed and enforced channels bill as unknown');
      return;
    }
    if (billing.basis === 'local-transport') {
      if (billing.posture !== 'local') issue('local transport bills as local');
      return;
    }
    const channel = billing.basis === 'enforced-channel' ? enforcedChannel : observedChannel;
    if (channel?.evidenceId !== billing.evidenceId) {
      issue(`billing evidence must match the ${billing.basis} evidence`);
      return;
    }
    if (channel.channel === 'api-key' && billing.posture === 'subscription-included') {
      issue('an api-key invocation is not subscription-included');
    }
  });

export type InvocationIdentity = z.infer<typeof InvocationIdentitySchema>;
