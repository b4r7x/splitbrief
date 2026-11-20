import { z } from 'zod';

/**
 * A static adapter id, or a CLI matrix entry id in an older record, never
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

export const InvocationIdentitySchema = z.strictObject({
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
});

export type InvocationIdentity = z.infer<typeof InvocationIdentitySchema>;
