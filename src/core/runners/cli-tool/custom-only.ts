import type { CustomOnlyCliToolExclusion } from './types.js';

const CUSTOM_ONLY_CLI_TOOL_DECLARATIONS = Object.freeze({
  kiro: Object.freeze({
    id: 'kiro',
    displayName: 'Amazon Kiro CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason: 'SPLITBRIEF has no structured session-scoped model and output adapter for it.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  gemini: Object.freeze({
    id: 'gemini',
    displayName: 'Gemini CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason:
        'Its auth, discovery, and permission contracts do not meet first-class-admission requirements.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  cline: Object.freeze({
    id: 'cline',
    displayName: 'Cline CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason:
        'Its auth, discovery, and permission contracts do not meet first-class-admission requirements.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  qwen: Object.freeze({
    id: 'qwen',
    displayName: 'Qwen Code',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason:
        'Its auth, discovery, and permission contracts do not meet first-class-admission requirements.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
});

export const CUSTOM_ONLY_CLI_TOOL_DEFINITIONS = Object.freeze([
  CUSTOM_ONLY_CLI_TOOL_DECLARATIONS.kiro,
  CUSTOM_ONLY_CLI_TOOL_DECLARATIONS.gemini,
  CUSTOM_ONLY_CLI_TOOL_DECLARATIONS.cline,
  CUSTOM_ONLY_CLI_TOOL_DECLARATIONS.qwen,
]);

export const CUSTOM_ONLY_CLI_TOOL_IDS = Object.freeze(
  CUSTOM_ONLY_CLI_TOOL_DEFINITIONS.map((tool) => tool.id),
);

export const EXCLUDED_CLI_TOOL_IDS = Object.freeze([
  ...CUSTOM_ONLY_CLI_TOOL_IDS,
  'auggie',
  'junie',
]);
