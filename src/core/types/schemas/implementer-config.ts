import { z } from 'zod';
import {
  CliRunnerFields,
  ApiRunnerFields,
  ShellRunnerFields,
  AgentRunnerFields,
  AgentSdkRunnerFields,
  GenerationCommonFields,
} from './runner-fields.js';

/**
 * Implementer config discriminated union.
 * 5 variants matching the 5 runner kinds.
 * Unlike planner, model is REQUIRED (local models need explicit identifier).
 */
export const ImplementerConfigSchema = z.discriminatedUnion('kind', [
  z.object({ ...CliRunnerFields, ...GenerationCommonFields }).strict(),
  z.object({ ...ApiRunnerFields, ...GenerationCommonFields }).strict(),
  z.object({ ...ShellRunnerFields, ...GenerationCommonFields }).strict(),
  z.object({ ...AgentRunnerFields, ...GenerationCommonFields }).strict(),
  z.object({ ...AgentSdkRunnerFields, ...GenerationCommonFields }).strict(),
]);

export type ImplementerConfig = z.infer<typeof ImplementerConfigSchema>;

// Per-variant narrowing types for factory functions
export type CliImplementerConfig = Extract<ImplementerConfig, { kind: 'cli' }>;
export type ApiImplementerConfig = Extract<ImplementerConfig, { kind: 'api' }>;
export type ShellImplementerConfig = Extract<ImplementerConfig, { kind: 'shell' }>;
export type AgentImplementerConfig = Extract<ImplementerConfig, { kind: 'agent' }>;
export type AgentSdkImplementerConfig = Extract<ImplementerConfig, { kind: 'agent-sdk' }>;

// Union of all implementer runner kinds
export type ImplementerRunnerKind = ImplementerConfig['kind'];
