export const PASS_API_PROVIDER_IDS = Object.freeze(
  [] as const satisfies readonly (
    | 'mistral'
    | 'gemini'
    | 'cerebras'
    | 'zai'
    | 'mimo'
    | 'mimo-token-plan'
    | 'minimax'
    | 'moonshot'
    | 'dashscope'
    | 'llama-cpp'
  )[],
);

export const FORBIDDEN_API_PROVIDER_IDS = Object.freeze([
  'kiro',
  'gemini-cli',
  'auggie',
  'junie',
  'cline',
  'qwen-coding-plan',
  'minimax-token-plan',
  'kimi-code',
  'zai-coding-plan',
  'alibaba-coding-plan',
  'siliconflow',
  'cloudflare',
  'github-models',
  'huggingface',
  'vllm',
  'localai',
  'local-openai',
  'sambanova',
  'nvidia-nim',
] as const);

export const API_PROVIDER_VERDICT_CANDIDATE_PATHS = Object.freeze([
  {
    id: 'mistral',
    source: 'src/engine/providers/candidates/mistral.ts',
    test: 'src/engine/providers/candidates/mistral.test.ts',
  },
  {
    id: 'gemini',
    source: 'src/engine/providers/candidates/gemini.ts',
    test: 'src/engine/providers/candidates/gemini.test.ts',
  },
  {
    id: 'cerebras',
    source: 'src/engine/providers/candidates/cerebras.ts',
    test: 'src/engine/providers/candidates/cerebras.test.ts',
  },
  {
    id: 'zai',
    source: 'src/engine/providers/candidates/zai.ts',
    test: 'src/engine/providers/candidates/zai.test.ts',
  },
  {
    id: 'mimo',
    source: 'src/engine/providers/candidates/mimo.ts',
    test: 'src/engine/providers/candidates/mimo.test.ts',
  },
  {
    id: 'mimo-token-plan',
    source: 'src/engine/providers/candidates/mimo-token-plan.ts',
    test: 'src/engine/providers/candidates/mimo-token-plan.test.ts',
  },
  {
    id: 'minimax',
    source: 'src/engine/providers/candidates/minimax.ts',
    test: 'src/engine/providers/candidates/minimax.test.ts',
  },
  {
    id: 'moonshot',
    source: 'src/engine/providers/candidates/moonshot.ts',
    test: 'src/engine/providers/candidates/moonshot.test.ts',
  },
  {
    id: 'dashscope',
    source: 'src/engine/providers/candidates/dashscope.ts',
    test: 'src/engine/providers/candidates/dashscope.test.ts',
  },
  {
    id: 'llama-cpp',
    source: 'src/engine/providers/llama-cpp.ts',
    test: 'src/engine/providers/llama-cpp.test.ts',
  },
] as const satisfies readonly {
  readonly id:
    | 'mistral'
    | 'gemini'
    | 'cerebras'
    | 'zai'
    | 'mimo'
    | 'mimo-token-plan'
    | 'minimax'
    | 'moonshot'
    | 'dashscope'
    | 'llama-cpp';
  readonly source: string;
  readonly test: string;
}[]);
