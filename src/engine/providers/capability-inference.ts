// Conservative per-model max-output ceiling used when models.dev limit.output is
// unknown. The api implementer's max_tokens must never exceed the model's output
// cap (the context window is not the output cap), or the request 400s. 8192 is the
// safe floor across the providers splitbrief targets.
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export function clampToMaxOutput(maxTokens: number, maxOutputTokens?: number | undefined): number {
  return Math.min(maxTokens, maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
}
