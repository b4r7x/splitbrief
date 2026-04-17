import { z } from 'zod';
import { GenerationCommonFields, createRunnerConfigSchema } from './runner-fields.js';

export const ImplementerConfigSchema = createRunnerConfigSchema(GenerationCommonFields);

export type ImplementerConfig = z.infer<typeof ImplementerConfigSchema>;

export type CliImplementerConfig = Extract<ImplementerConfig, { kind: 'cli' }>;
export type ApiImplementerConfig = Extract<ImplementerConfig, { kind: 'api' }>;
export type ShellImplementerConfig = Extract<ImplementerConfig, { kind: 'shell' }>;
export type AgentImplementerConfig = Extract<ImplementerConfig, { kind: 'agent' }>;
export type AgentSdkImplementerConfig = Extract<ImplementerConfig, { kind: 'agent-sdk' }>;

