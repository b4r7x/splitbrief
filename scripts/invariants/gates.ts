export interface Gate {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly expected: number;
}

export const gates: readonly Gate[] = [
  {
    id: '1',
    description: 'No barrel index.ts files',
    command: "find src -name 'index.ts' | wc -l",
    expected: 0,
  },
  {
    id: '1b',
    description: 'No barrel index.tsx files',
    command: "find src -name 'index.tsx' | wc -l",
    expected: 0,
  },
  {
    id: '2',
    description: 'No z.infer in core/types/',
    command: '{ rg "z\\.infer" src/core/types/ || true; } | wc -l',
    expected: 0,
  },
  {
    id: '3',
    description: 'Zero memoization / imperative handles',
    command:
      '{ rg "useMemo|useCallback|React\\.memo|forwardRef|useImperativeHandle" src/ || true; } | wc -l',
    expected: 0,
  },
  {
    id: '4',
    description: 'No raw new Error in engine/lib/cli/core (any spelling, not just throw)',
    command:
      "{ rg \"new Error\\(\" src/engine/ src/lib/ src/cli/ src/core/ | rg -v '\\.test\\.' | rg -v 'recordException\\(new Error' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '5',
    description: 'No raw setter on store facade',
    command: '{ rg "^\\s*set:\\s*store\\.set" src/stores/ || true; } | wc -l',
    expected: 0,
  },
  {
    id: '6',
    description: 'simple-git only in src/lib/git/client.ts',
    command:
      "{ rg \"from 'simple-git'\" src/ --glob '!**/*.test.ts' | rg -v '^src/lib/git/client.ts:' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '8',
    description: 'Zero runtime classes in production source',
    command:
      "{ rg \"\\bclass\\s+\\w+\" src/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '9',
    description:
      'No cross-feature or component->feature imports (resolver-based: components->features, features/<a>-><b>)',
    command: 'tsx scripts/import-boundaries.ts src',
    expected: 0,
  },
  {
    id: '10',
    description: 'No callbacks.onEvent (post-migration guard)',
    command: '{ grep -rn "callbacks\\.onEvent" src/ || true; } | wc -l',
    expected: 0,
  },
  {
    id: '11',
    description: 'No OrchestratorEvent (post-migration guard)',
    command: '{ grep -rn "OrchestratorEvent\\b" src/ || true; } | wc -l',
    expected: 0,
  },
  {
    id: '12',
    description: 'Engine must not import from features',
    command: "{ grep -rln 'from.*features' src/engine | grep -v '\\.test\\.' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '12b',
    description: 'Engine must not import react or ink',
    command:
      "{ rg -ln \"from 'react'|from 'ink'\" src/engine/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '12c',
    description:
      'Engine must not import from src/components/ or src/hooks/ or src/cli/ (resolver-based, depth-independent)',
    command:
      '{ BOUNDARY_VERBOSE=1 tsx scripts/import-boundaries.ts src 2>&1 1>/dev/null | rg "src/engine/\\*\\* must not import" || true; } | wc -l',
    expected: 0,
  },
  {
    id: '13',
    description: 'No TuiEvent (post-migration guard)',
    command: '{ grep -rn "\\bTuiEvent\\b" src/ || true; } | wc -l',
    expected: 0,
  },
  {
    id: '14',
    description: 'React architecture refactor guard',
    command: `{ rg -n -e "components/input-bar" -e "core/slash-commands" -e "features/tool-picker" -e "hooks/use-app-keys" -e "workflow/components/command-palette-overlay" -e "engine/palette-aggregate" -e "InputBar" -e "toPaletteItems" -e "slashItems" -e "source: 'slash'" -e "'slash:'" src || true; rg -n -e "components/input-bar" -e "core/slash-commands" -e "features/tool-picker" -e "hooks/use-app-keys" -e "workflow/components/command-palette-overlay" -e "engine/palette-aggregate" -e "InputBar" -e "toPaletteItems" -e "slashItems" -e "source: 'slash'" -e "'slash:'" CLAUDE.md docs --glob '*.md' --glob '!docs/INVARIANTS.md' || true; } | wc -l`,
    expected: 0,
  },
  {
    id: '15',
    description: 'No hidden ASCII control bytes in source',
    command:
      "find src -type f \\( -name '*.ts' -o -name '*.tsx' \\) -exec perl -ne 'while (/([\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F])/g) { printf \"%s:%d:%d:U+%04X\\n\", $ARGV, $., pos($_), ord($1) } close ARGV if eof' {} + | wc -l",
    expected: 0,
  },
  {
    id: '16',
    description: 'Relative imports must use .js extension',
    command:
      "{ rg -n \"from '\\.\\.?/\" src/ --glob '*.ts' --glob '*.tsx' --glob '!**/*.test.ts' --glob '!**/*.test.tsx' | rg -v \"\\.js'|\\.json'\" || true; } | wc -l",
    expected: 0,
  },
  {
    id: '17',
    description: 'No incidental non-null assertions (sanctioned files in CLAUDE.md allow-listed)',
    command: `{ rg -n -P "[A-Za-z0-9_)\\]]![^=)]" src/ -g "*.ts" -g "*.tsx" -g "!**/*.test.ts" -g "!**/*.test.tsx" | rg -v "!==|!=" | rg -v "^src/(stores/use-stores|engine/codebase/graph|engine/codebase/pagerank)\\.ts:" || true; } | wc -l`,
    expected: 0,
  },
  {
    id: '17b',
    description: 'No explicit any (type positions only; prose excluded via terminator lookahead)',
    command: `{ rg -n -P ":\\s*any\\b(?![ ]?[a-z])|<any>|\\bany\\[\\]|\\bas any\\b|Array<any>" src/ -g "*.ts" -g "*.tsx" -g "!**/*.test.ts" -g "!**/*.test.tsx" || true; } | wc -l`,
    expected: 0,
  },
  {
    id: '17c',
    description:
      'No incidental broad as-casts (type token must be followed by a terminator, excluding as const/as unknown/as Extract, comment lines, and sanctioned files)',
    command: `{ rg -n -P "[)\\]}A-Za-z0-9_>'] as [A-Z][A-Za-z0-9_]*(?=\\s*[;),<\\].}>&|]|$|\\[)" src/ -g "*.ts" -g "*.tsx" -g "!**/*.test.ts" -g "!**/*.test.tsx" | rg -v "\\bas const\\b|\\bas unknown\\b| as Extract<" | rg -v -P "^[^:]+:\\d+:\\s*(?://|\\*|/\\*)" | rg -v "^src/(stores/use-stores|engine/hooks/substitute|utils/error|utils/type-guards)\\.ts:" || true; } | wc -l`,
    expected: 0,
  },
  {
    id: '18',
    description: 'No dead exports/files (knip)',
    command:
      '{ npx knip --no-progress --no-config-hints --tags=-lintignore --include exports,types,files --reporter compact | rg . || true; } | wc -l',
    expected: 0,
  },
  {
    id: '19',
    description: 'No runtime circular deps + layer-direction graph (dependency-cruiser)',
    command:
      '{ npx depcruise --config .dependency-cruiser.cjs --output-type err-long src | rg "^\\s+error " || true; } | wc -l',
    expected: 0,
  },
  {
    id: '20',
    description:
      'Test files must import top-level testing/helpers via #testing alias, not relative paths',
    command: 'tsx scripts/testing-helper-imports.ts | wc -l',
    expected: 0,
  },
  {
    id: '22',
    description: 'Active agent instruction surfaces must not reference removed APIs',
    command:
      '{ for path in .github/prompts .claude/commands .claude/skills .opencode/command; do [ -e "$path" ] && rg -n \'\\bTuiEvent\\b|src/screens/|src/ui/\' "$path" || true; done; } | wc -l',
    expected: 0,
  },
  {
    id: '21',
    description:
      'No present tracked runtime artifacts under .splitbrief/ or .nuke/ (excluding intentional fixtures)',
    command:
      '{ git ls-files -z .splitbrief/ .nuke/ | while IFS= read -r -d \'\' path; do [ -e "$path" ] && printf \'%s\\n\' "$path"; done || true; } | wc -l',
    expected: 0,
  },
  {
    id: '23',
    description:
      'VISION.md NOT-list hosts every non-goal that satellite docs redirect to (kanban, plan archive, cross-plan, swarm, project-management)',
    command:
      "{ for term in 'kanban' 'plan archive' 'cross-plan' 'swarm' 'project-management'; do rg -iq \"$term\" docs/VISION.md || printf 'missing: %s\\n' \"$term\"; done; } | wc -l",
    expected: 0,
  },
  {
    id: '24',
    description:
      'CON-C: inline editor path imports no child_process / editor-handover / $EDITOR|VISUAL / scratch writer',
    command: `{ rg -n "child_process|editor-handover|\\bEDITOR\\b|\\bVISUAL\\b|scratch" src/features/editor/ src/stores/ui/editor.ts src/app/overlays/editor.tsx --glob '!**/*.test.ts' --glob '!**/*.test.tsx' || true; } | wc -l`,
    expected: 0,
  },
  {
    id: '25',
    description: 'CON-E: inline editor reads session artifacts only via readSessionFileConfined',
    command: `{ rg -n "\\breadFileSync\\b|\\breadFile\\b|from 'node:fs'|from 'fs'" src/features/editor/ src/stores/ui/editor.ts src/app/overlays/editor.tsx --glob '!**/*.test.ts' --glob '!**/*.test.tsx' || true; } | wc -l`,
    expected: 0,
  },
  {
    id: '26',
    description:
      'TUI key-token notation: no Ctrl+/Shift+/ESC/Esc/⌃/PgUp/PgDn in rendered TUI sources (lowercase tokens only)',
    command:
      "{ rg -n \"Ctrl\\+|Shift\\+|\\bESC\\b|\\bEsc\\b|⌃|PgUp|PgDn\" src/app src/features src/components src/core/keybindings src/core/settings src/core/runtime/commands -g '!**/*.test.*' | rg -v ':\\s*(//|\\*|/\\*)' | rg -v '^src/core/keybindings/normalize\\.ts:' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '27',
    description: 'Maintained tree uses only canonical SPLITBRIEF identity',
    command: "tsx scripts/check-brand.ts >/dev/null && printf '0\\n'",
    expected: 0,
  },
  {
    id: '28',
    description: 'Zero legacy CLI_TOOLS / cli-tools.ts / clampPromptForArgv',
    command:
      '{ rg -n "cli-tools\\.js|CLI_TOOLS|clampPromptForArgv" src testing || true; test -e src/engine/runners/cli-tools.ts && printf \'1\\n\' || true; } | wc -l',
    expected: 0,
  },
  {
    id: '29',
    description: 'Exhaustive CLI and API role registries match catalog tuples',
    command:
      "node --import tsx/esm --input-type=module -e \"import { CLI_PLANNER_ADAPTERS, CLI_IMPLEMENTER_ADAPTERS } from './src/engine/runners/cli-tools/registry.ts'; import { PLANNER_CLI_TOOL_IDS, IMPLEMENTER_CLI_TOOL_IDS } from './src/core/runners/cli-tool-catalog.ts'; import { API_PROVIDER_CATALOG } from './src/core/providers/api-provider-catalog.ts'; import { KNOWN_PROVIDERS } from './src/engine/providers/registry.ts'; let n=0; if (JSON.stringify(Object.keys(CLI_PLANNER_ADAPTERS)) !== JSON.stringify([...PLANNER_CLI_TOOL_IDS])) n++; if (JSON.stringify(Object.keys(CLI_IMPLEMENTER_ADAPTERS)) !== JSON.stringify([...IMPLEMENTER_CLI_TOOL_IDS])) n++; if (JSON.stringify(Object.keys(KNOWN_PROVIDERS).toSorted()) !== JSON.stringify(Object.keys(API_PROVIDER_CATALOG).toSorted())) n++; process.stdout.write(String(n));\"",
    expected: 0,
  },
  {
    id: '30',
    description: 'Engine must not import react, react-dom, or ink',
    command:
      "{ rg -ln \"from 'react'|from 'react-dom'|from 'ink'\" src/engine/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '31',
    description: 'No vendor-ID JSX branches in seat-selection surfaces (comment lines excluded)',
    command:
      "{ rg -i \"\\\\b(cursor|antigravity|mimo-token-plan|mistral|gemini|cerebras|zai|minimax|moonshot|dashscope|llama-cpp)\\\\b\" src/features/runners src/app/overlays/runners.tsx src/features/crew src/features/settings src/app/overlays/settings.tsx src/app/screens/setup.tsx --glob '*.tsx' --glob '!**/*.test.tsx' -n | rg -v -P '^[^:]+:\\d+:\\s*(?://|\\*|/\\*)' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '32',
    description: 'One OpenAI-compatible stream transport (openai-stream only)',
    command:
      "{ { [ -e src/engine/providers/candidates ] && rg -n 'fetch\\(|ReadableStream|EventSource|for await|\\[DONE\\]' src/engine/providers/candidates --glob '!*.test.*' 2>/dev/null || true; [ -f src/engine/providers/llama-cpp.ts ] && rg -n 'fetch\\(|ReadableStream|EventSource|for await|\\[DONE\\]' src/engine/providers/llama-cpp.ts --glob '!*.test.*' 2>/dev/null || true; rg -ln \"chat\\.completions\\.create\" src/engine/providers/ --glob '!**/*.test.*' 2>/dev/null | rg -v '^src/engine/providers/openai-stream/' || true; } | wc -l; }",
    expected: 0,
  },
  {
    id: '33',
    description: 'No runtime commercial metadata URL fetch outside models.dev module',
    command:
      '{ { rg -n "fetch(Json)?WithTimeout\\(" src/ --glob \'!**/*.test.*\' | rg -i "privacy|/terms|pricing|marketing|quota" | rg -v "^src/engine/providers/models-dev\\.ts:" || true; rg -n "privacyURL|termsURL" src/ --glob \'!**/*.test.*\' | rg -v "^src/core/providers/" | rg -v "^src/engine/providers/candidate-contract.ts:" || true; } | wc -l; }',
    expected: 0,
  },
  {
    id: '34',
    description: 'Zero excluded first-class CLI/API IDs in runtime tuples or catalogs',
    command:
      "node --import tsx/esm --input-type=module -e \"import { EXCLUDED_CLI_TOOL_IDS, CLI_TOOL_CATALOG } from './src/core/runners/cli-tool-catalog.ts'; import { API_PROVIDER_CATALOG } from './src/core/providers/api-provider-catalog.ts'; import { FORBIDDEN_API_PROVIDER_IDS } from './src/core/providers/api-provider-verdicts.ts'; import { PROVIDER_IDS, PLANNER_TOOL_IDS } from './src/core/schemas/enums.ts'; let n=0; const admitted=new Set([...PROVIDER_IDS,...PLANNER_TOOL_IDS,...Object.keys(CLI_TOOL_CATALOG),...Object.keys(API_PROVIDER_CATALOG)]); for (const id of EXCLUDED_CLI_TOOL_IDS) if (admitted.has(id)) n++; for (const id of FORBIDDEN_API_PROVIDER_IDS) if (admitted.has(id)) n++; process.stdout.write(String(n));\"",
    expected: 0,
  },
  {
    id: '35',
    description: 'Zero source index.ts barrels',
    command: "find src -name 'index.ts' | wc -l",
    expected: 0,
  },
  {
    id: '46',
    description: 'Pinned overlay widths are gone',
    command:
      '{ rg -n "maxWidth=" src/app src/features src/components/overlays || true; rg -n "getResponsivePanelWidth|getClampedTerminalWidth|PICKER_WIDTHS|SUB_PANEL_MAX_WIDTH|MAX_PANEL_WIDTH|SETUP_PANEL_WIDTH|PALETTE_MAX_WIDTH" src || true; rg -n "isSmall" src/app/overlays src/app/screens/home.tsx src/app/screens/setup.tsx src/features/home/layout.ts src/features/runners src/features/start-preparation src/features/workflow/cost-drilldown src/components/overlays src/components/pickers testing/visual/locators/registry.ts --glob \'!**/*.test.ts\' --glob \'!**/*.test.tsx\' || true; } | wc -l',
    expected: 0,
  },
  {
    id: '47',
    description: 'Capability inference is imported from core, never from engine',
    command:
      "{ rg -n \"from '.*engine/providers/capability-inference\" src/features src/app src/components src/core --glob '!**/*.test.ts' --glob '!**/*.test.tsx' || true; } | wc -l",
    expected: 0,
  },
];

export function getInvariantGates(id: string): readonly Gate[] {
  return gates.filter((gate) => gate.id === id).map((gate) => ({ ...gate }));
}
