import { CLI_TOOL_DECLARATIONS } from './catalog.js';

export const CUSTOM_ONLY_CLI_TOOL_DEFINITIONS = Object.freeze([
  CLI_TOOL_DECLARATIONS.kiro,
  CLI_TOOL_DECLARATIONS.gemini,
  CLI_TOOL_DECLARATIONS.cline,
  CLI_TOOL_DECLARATIONS.qwen,
]);

export const CUSTOM_ONLY_CLI_TOOL_IDS = Object.freeze(
  CUSTOM_ONLY_CLI_TOOL_DEFINITIONS.map((tool) => tool.id),
);

export const EXCLUDED_CLI_TOOL_IDS = Object.freeze([
  ...CUSTOM_ONLY_CLI_TOOL_IDS,
  'auggie',
  'junie',
]);
