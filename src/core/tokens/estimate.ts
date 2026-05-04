const DEFAULT_CHARS_PER_TOKEN = 4;

const MODEL_FAMILY_RATIOS: Record<string, number> = {
  claude: 3.5,
  gpt: 4.0,
  o1: 4.0,
  o3: 4.0,
  o4: 4.0,
  deepseek: 3.8,
  qwen: 3.6,
  llama: 3.8,
  gemma: 3.8,
  mistral: 3.7,
  codestral: 3.7,
  phi: 3.9,
  gemini: 3.8,
};

export function resolveCharsPerToken(modelId?: string): number {
  if (!modelId) return DEFAULT_CHARS_PER_TOKEN;
  const lower = modelId.toLowerCase();
  for (const [family, ratio] of Object.entries(MODEL_FAMILY_RATIOS)) {
    if (family.length <= 2) {
      if (lower.startsWith(family) || lower.includes(`-${family}`) || lower.includes(`/${family}`)) return ratio;
    } else {
      if (lower.includes(family)) return ratio;
    }
  }
  return DEFAULT_CHARS_PER_TOKEN;
}

export function estimateTokens(text: string, modelId?: string): number {
  return Math.ceil(text.length / resolveCharsPerToken(modelId));
}
