import { z } from 'zod';
import type { DetectedModel } from './types.js';
import type { CliToolId } from '../../core/types/schemas/enums.js';
import { runCommand } from '../../utils/process.js';
import { perTokenToPerMillion } from './metadata.js';

const SUBPROCESS_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 5_000;

const KILO_MODELS_URL = 'https://api.kilo.ai/api/gateway/models';

const KiloModelSchema = z.object({
  id: z.string(),
  context_length: z.number().optional(),
  pricing: z
    .object({
      prompt: z.number().optional(),
      completion: z.number().optional(),
    })
    .optional(),
});

const KiloModelsResponseSchema = z.object({
  data: z.array(KiloModelSchema),
});

function parseSubprocessLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('-') && !line.startsWith('=') && !/error/i.test(line));
}

export async function discoverAiderModels(): Promise<DetectedModel[]> {
  try {
    const { stdout } = await runCommand('aider', ['--list-models', ''], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return parseSubprocessLines(stdout).map((id) => ({ id }));
  } catch {
    return [];
  }
}

export async function discoverOpencodeModels(): Promise<DetectedModel[]> {
  try {
    const { stdout } = await runCommand('opencode', ['models'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return parseSubprocessLines(stdout).map((id) => ({ id }));
  } catch {
    return [];
  }
}

export async function discoverKiloModels(): Promise<DetectedModel[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let json: unknown;
    try {
      const res = await fetch(KILO_MODELS_URL, { signal: controller.signal });
      if (!res.ok) return [];
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const parsed = KiloModelsResponseSchema.safeParse(json);
    if (!parsed.success) return [];

    return parsed.data.data.map((m) => {
      const model: DetectedModel = { id: m.id };
      if (m.context_length !== undefined) {
        model.contextLength = m.context_length;
      }
      if (m.pricing?.prompt !== undefined) {
        model.pricingInput = perTokenToPerMillion(m.pricing.prompt);
      }
      if (m.pricing?.completion !== undefined) {
        model.pricingOutput = perTokenToPerMillion(m.pricing.completion);
      }
      return model;
    });
  } catch {
    return [];
  }
}

export function discoverCliToolModels(toolId: CliToolId): Promise<DetectedModel[]> {
  switch (toolId) {
    case 'aider': return discoverAiderModels();
    case 'opencode': return discoverOpencodeModels();
    case 'kilo-code': return discoverKiloModels();
    default: return Promise.resolve([]);
  }
}

export async function discoverAllCliTools(): Promise<Partial<Record<CliToolId, DetectedModel[]>>> {
  const [aider, opencode, kilo] = await Promise.all([
    discoverAiderModels(),
    discoverOpencodeModels(),
    discoverKiloModels(),
  ]);

  const result: Partial<Record<CliToolId, DetectedModel[]>> = {};
  if (aider.length > 0) result.aider = aider;
  if (opencode.length > 0) result.opencode = opencode;
  if (kilo.length > 0) result['kilo-code'] = kilo;
  return result;
}
