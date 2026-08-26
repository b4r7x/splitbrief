import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Gate {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly expected: number;
}

const gates: readonly Gate[] = [
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
    id: '7',
    description: 'No global env mutation in agent-sdk runner',
    command:
      '{ rg "process\\.env(?:\\.[A-Z_]+|\\[[\'\\"\'][A-Z_]+[\'\\"]\\])\\s*=" src/engine/runners/agent-sdk --glob "!**/*.test.ts" || true; } | wc -l',
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
      'No incidental broad as-casts (type token must be followed by a terminator, excluding as const/as unknown/as Extract and sanctioned files)',
    command: `{ rg -n -P "[)\\]}A-Za-z0-9_>'] as [A-Z][A-Za-z0-9_]*(?=\\s*[;),<\\].}>&|]|$|\\[)" src/ -g "*.ts" -g "*.tsx" -g "!**/*.test.ts" -g "!**/*.test.tsx" | rg -v "\\bas const\\b|\\bas unknown\\b| as Extract<" | rg -v "^src/(stores/use-stores|engine/hooks/substitute|utils/error|utils/type-guards)\\.ts:" || true; } | wc -l`,
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
    description: 'No vendor-ID JSX branches in seat-selection surfaces',
    command:
      "{ rg -i \"\\\\b(cursor|antigravity|mimo-token-plan|mistral|gemini|cerebras|zai|minimax|moonshot|dashscope|llama-cpp)\\\\b\" src/features/runners src/app/overlays/runners.tsx src/features/crew src/features/settings src/app/overlays/settings.tsx src/app/screens/setup.tsx --glob '*.tsx' --glob '!**/*.test.tsx' || true; } | wc -l",
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
      "node --import tsx/esm --input-type=module -e \"import { EXCLUDED_CLI_TOOL_IDS, CLI_TOOL_CATALOG } from './src/core/runners/cli-tool-catalog.ts'; import { FORBIDDEN_API_PROVIDER_IDS, API_PROVIDER_CATALOG } from './src/core/providers/api-provider-catalog.ts'; import { PROVIDER_IDS, PLANNER_TOOL_IDS } from './src/core/schemas/enums.ts'; let n=0; const admitted=new Set([...PROVIDER_IDS,...PLANNER_TOOL_IDS,...Object.keys(CLI_TOOL_CATALOG),...Object.keys(API_PROVIDER_CATALOG)]); for (const id of EXCLUDED_CLI_TOOL_IDS) if (admitted.has(id)) n++; for (const id of FORBIDDEN_API_PROVIDER_IDS) if (admitted.has(id)) n++; process.stdout.write(String(n));\"",
    expected: 0,
  },
  {
    id: '35',
    description: 'Zero source index.ts barrels',
    command: "find src -name 'index.ts' | wc -l",
    expected: 0,
  },
  {
    id: '36',
    description: 'T-065 direct state writes stay behind persistence/state-ops',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule direct-state | wc -l',
    expected: 0,
  },
  {
    id: '37',
    description: 'T-065 raw state.json replacement stays in core state persistence',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule raw-state-writer | wc -l',
    expected: 0,
  },
  {
    id: '38',
    description: 'T-065 recovery reducer is imported only by its controller',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule reducer-import | wc -l',
    expected: 0,
  },
  {
    id: '39',
    description: 'T-065 BRIEFS_READY ownership is path-aware',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule briefs-ready | wc -l',
    expected: 0,
  },
  {
    id: '40',
    description: 'T-065 quality evaluation is controller-owned',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule quality-gate | wc -l',
    expected: 0,
  },
  {
    id: '41',
    description: 'T-065 continuation guard has one implementation',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule continuation | wc -l',
    expected: 0,
  },
  {
    id: '42',
    description: 'T-065 recovery planner.review has one provider boundary',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule recovery-provider | wc -l',
    expected: 0,
  },
  {
    id: '43',
    description: 'T-065 recovery continuation markers cannot re-enter review',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule recovery-marker | wc -l',
    expected: 0,
  },
  {
    id: '44',
    description: 'T-065 client adapters use controller/projection seams',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule adapters | wc -l',
    expected: 0,
  },
  {
    id: '45',
    description: 'T-065 hydration paths are exhaustively classified',
    command: 'tsx scripts/check-invariants.ts --t065-scan src/ --rule hydration | wc -l',
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

export const T065_RULES = [
  'direct-state',
  'raw-state-writer',
  'reducer-import',
  'briefs-ready',
  'quality-gate',
  'continuation',
  'recovery-provider',
  'recovery-marker',
  'adapters',
  'hydration',
] as const;

export type T065Rule = (typeof T065_RULES)[number];

export type T065Finding = Readonly<{
  rule: T065Rule;
  path: string;
  line: number;
  message: string;
}>;

type T065SourceFile = Readonly<{
  absolutePath: string;
  displayPath: string;
  relativePath: string;
  text: string;
  lines: readonly string[];
}>;

const T065_OWNER_PATHS = [
  'src/app/prepare-resume.ts',
  'src/cli/commands/continue/command.ts',
  'src/cli/commands/resume.ts',
  'src/cli/headless.ts',
  'src/cli/rpc/run/host.ts',
  'src/engine/ipc/workflow-loop/run.ts',
  'src/engine/ipc/workflow-loop/recovery.ts',
  'src/engine/orchestrator/planning/failure.ts',
  'src/engine/orchestrator/recovery/driver.ts',
  'src/engine/orchestrator/run/workflow.ts',
  'src/engine/orchestrator/transcript/rebuild.ts',
  'src/features/workflow/hooks/use-runner.ts',
  'src/features/workflow/hooks/workflow-screen/resume.ts',
  'src/stores/navigation/session-select.ts',
] as const;

const T065_STRICT_V4_PATHS = [
  'src/cli/commands/status.ts',
  'src/core/sessions/io.ts',
  'src/core/state/persistence.ts',
  'src/engine/handoff/write.ts',
  'src/engine/ipc/server-entry.ts',
  'src/engine/orchestrator/explain/artifacts.ts',
  'src/engine/orchestrator/queue/native-injection.ts',
  'src/engine/orchestrator/state-ops.ts',
  'src/engine/orchestrator/task/retry.ts',
  'src/engine/orchestrator/transcript/compaction.ts',
] as const;

const T065_PERSISTENCE_PATH = 'src/core/state/persistence.ts';
const T065_STATE_OPS_PATH = 'src/engine/orchestrator/state-ops.ts';
const T065_CONTROLLER_PATH = 'src/engine/orchestrator/planning/brief-recovery-controller.ts';
const T065_REDUCER_PATH = 'src/engine/orchestrator/planning/brief-recovery.ts';
const T065_QUALITY_GATE_PATH = 'src/engine/orchestrator/planning/brief-quality-gate.ts';
const T065_CONTINUATION_PATH = 'src/engine/orchestrator/continuation.ts';
const T065_REGEN_PATH = 'src/engine/orchestrator/planning/regen.ts';
const T065_PROVIDER_PATH = 'src/engine/orchestrator/planning/brief-recovery-provider.ts';
const T065_PLANNER_REVIEW_PATH = 'src/engine/orchestrator/planner-review.ts';
const T065_HARNESS_PATH = 'src/engine/runners/cli-tools/contract-harness.ts';
const T065_HARNESS_EFFECTS_PATH = 'src/engine/runners/cli-tools/contract-harness-effects.ts';

function normalizePath(value: string): string {
  return value.split(sep).join('/');
}

function sourcePathMatches(file: T065SourceFile, path: string): boolean {
  const normalized = normalizePath(path);
  const expected = normalized.startsWith('src/') ? normalized.slice('src/'.length) : normalized;
  return file.relativePath === expected || file.relativePath.endsWith(`/${expected}`);
}

function sourceFiles(root: string): T065SourceFile[] {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`T-065 source root does not exist: ${root}`);
  }

  const files: T065SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) {
        continue;
      }
      const relativePath = normalizePath(relative(absoluteRoot, absolutePath));
      const displayPath = normalizePath(relative(process.cwd(), absolutePath));
      const text = readFileSync(absolutePath, 'utf8');
      files.push({
        absolutePath,
        displayPath: displayPath || normalizePath(absolutePath),
        relativePath,
        text,
        lines: text.split(/\r?\n/u),
      });
    }
  };
  visit(absoluteRoot);
  return files.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

function t065PathAllowed(file: T065SourceFile, paths: readonly string[]): boolean {
  return paths.some((path) => sourcePathMatches(file, path));
}

function lineMatches(lines: readonly string[], pattern: RegExp): number[] {
  const matches: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) matches.push(index + 1);
    pattern.lastIndex = 0;
  }
  return matches;
}

function scanT065Rule(files: readonly T065SourceFile[], rule: T065Rule): T065Finding[] {
  const findings: T065Finding[] = [];
  const add = (file: T065SourceFile, line: number, message: string): void => {
    findings.push({ rule, path: file.displayPath, line, message });
  };

  for (const file of files) {
    const allowedPersistence = sourcePathMatches(file, T065_PERSISTENCE_PATH);
    const allowedStateOps = sourcePathMatches(file, T065_STATE_OPS_PATH);
    const isController = sourcePathMatches(file, T065_CONTROLLER_PATH);

    if (rule === 'direct-state') {
      if (allowedPersistence || allowedStateOps) continue;
      for (const line of lineMatches(
        file.lines,
        /(?:\bimport\b[^;]*\bsaveState\b|\bsaveState\s*\()/u,
      )) {
        add(file, line, 'direct saveState is only legal in state persistence or state-ops');
      }
    }

    if (rule === 'raw-state-writer') {
      if (allowedPersistence) continue;
      const hasStateReference = /\bSTATE_FILE\b|state\.json/u.test(file.text);
      const directStateWriterLine = lineMatches(
        file.lines,
        /(?:\bSTATE_FILE\b|state\.json).*\b(?:writeFileSync|writeFile|renameSync|rename|replaceSync|replace)\b|\b(?:writeFileSync|writeFile|renameSync|rename|replaceSync|replace)\b.*(?:\bSTATE_FILE\b|state\.json)/u,
      )[0];
      if (directStateWriterLine !== undefined) {
        add(
          file,
          directStateWriterLine,
          'raw state.json replacement is only legal in core state persistence',
        );
      } else if (hasStateReference && /\bconfinedAtomicWriteFileSync\b/u.test(file.text)) {
        const line = lineMatches(file.lines, /\bconfinedAtomicWriteFileSync\b/u)[0] ?? 1;
        add(file, line, 'raw state.json replacement is only legal in core state persistence');
      }
    }

    if (rule === 'reducer-import') {
      const planningSource = /(?:^|\/)engine\/orchestrator\/planning\//u.test(file.relativePath);
      if (isController || sourcePathMatches(file, T065_REDUCER_PATH)) continue;
      for (const line of lineMatches(
        file.lines,
        planningSource
          ? /\bfrom\s+['"][^'"]*(?:\/planning\/brief-recovery|\.\/brief-recovery)\.js['"]/u
          : /\bfrom\s+['"][^'"]+\/planning\/brief-recovery\.js['"]/u,
      )) {
        add(file, line, 'the pure recovery reducer may only be imported by its controller');
      }
    }

    if (rule === 'briefs-ready') {
      const allowed =
        sourcePathMatches(file, 'src/core/state/types.ts') ||
        sourcePathMatches(file, 'src/core/state/machine.ts') ||
        isController;
      if (allowed) continue;
      for (const line of lineMatches(file.lines, /\bBRIEFS_READY\b/u)) {
        add(
          file,
          line,
          'BRIEFS_READY may only be declared, interpreted, or emitted at its owner seam',
        );
      }
    }

    if (rule === 'quality-gate') {
      const qualityGate = sourcePathMatches(file, T065_QUALITY_GATE_PATH);
      if (qualityGate || isController) continue;
      for (const line of lineMatches(file.lines, /\brunBriefQualityGate\b/u)) {
        add(
          file,
          line,
          'runBriefQualityGate is controller-owned and cannot be called by an adapter',
        );
      }
    }

    if (rule === 'continuation') {
      const continuation = sourcePathMatches(file, T065_CONTINUATION_PATH);
      const regeneration = sourcePathMatches(file, T065_REGEN_PATH);
      if (!continuation) {
        for (const line of lineMatches(file.lines, /\bRecoveryContinuationMarker\b/u)) {
          add(file, line, 'RecoveryContinuationMarker has a single implementation');
        }
      }
      if (!continuation && !regeneration) {
        for (const line of lineMatches(file.lines, /\bnoAutomaticContinuation\s*:/u)) {
          add(
            file,
            line,
            'noAutomaticContinuation may only be implemented by the continuation seam',
          );
        }
      }
      const recoveryMarker = lineMatches(file.lines, /\bbriefRecovery\s*:\s*true\b/u);
      if (recoveryMarker.length > 0 && !continuation) {
        if (!regeneration) {
          add(
            file,
            recoveryMarker[0] ?? 1,
            'recovery continuation marker has a single implementation',
          );
        } else if (
          !/\bnoAutomaticContinuation\s*:\s*true\b/u.test(file.text) ||
          !/\boperationId\b/u.test(file.text)
        ) {
          add(
            file,
            recoveryMarker[0] ?? 1,
            'recovery continuation marker must carry operationId and noAutomaticContinuation',
          );
        }
      }
    }

    if (rule === 'recovery-provider') {
      const provider = sourcePathMatches(file, T065_PROVIDER_PATH);
      const plannerReview = sourcePathMatches(file, T065_PLANNER_REVIEW_PATH);
      // test-only conformance driver calling the production factory directly
      const harness =
        sourcePathMatches(file, T065_HARNESS_PATH) ||
        sourcePathMatches(file, T065_HARNESS_EFFECTS_PATH);
      if (!provider && !plannerReview && !harness) {
        for (const line of lineMatches(file.lines, /\bplanner\s*\.\s*review\s*\(/u)) {
          add(file, line, 'recovery planner.review calls must cross brief-recovery-provider.ts');
        }
      }
      if (plannerReview && !/createBriefRecoveryProvider|\.dispatch\s*\(/u.test(file.text)) {
        add(file, 1, 'planner-review.ts must delegate explicit recovery calls to the provider');
      }
    }

    if (rule === 'recovery-marker') {
      if (sourcePathMatches(file, T065_CONTINUATION_PATH)) continue;
      const recoveryMarker = lineMatches(file.lines, /\bbriefRecovery\s*:\s*true\b/u);
      if (recoveryMarker.length === 0) continue;
      if (
        !/\bnoAutomaticContinuation\s*:\s*true\b/u.test(file.text) ||
        !/\boperationId\b/u.test(file.text)
      ) {
        add(
          file,
          recoveryMarker[0] ?? 1,
          'recovery continuation requires noAutomaticContinuation and operationId',
        );
      }
      for (const line of lineMatches(
        file.lines,
        /\bonContinuationNeeded\b|\bplanner\s*\.\s*review\s*\(/u,
      )) {
        add(
          file,
          line,
          'recovery continuation cannot invoke a second review or continuation callback',
        );
      }
    }

    if (rule === 'adapters') {
      const adapter = /^(?:cli|engine\/ipc|features|stores)\//u.test(file.relativePath);
      if (!adapter) continue;
      for (const line of lineMatches(
        file.lines,
        /\b(?:runBriefQualityGate|reduceBriefRecovery|planner\s*\.\s*review)\b/u,
      )) {
        add(file, line, 'client adapters may only call the recovery controller/public projection');
      }
    }

    if (rule === 'hydration') {
      const owner = t065PathAllowed(file, T065_OWNER_PATHS);
      const strictV4 = t065PathAllowed(file, T065_STRICT_V4_PATHS);
      const directLoad = lineMatches(
        file.lines,
        /(?:\bloadState\s*\(|\.loadState\s*\(|\bimport\b[^;]*\bloadState\b)/u,
      );
      if (owner) {
        if (directLoad.length > 0) {
          add(file, directLoad[0] ?? 1, 'owner hydration cannot call loadState directly');
        }
        if (
          !/\bloadStateForResume\b|\bloadOwnerWorkflowState\b|\bhydrate(?:Resume|State)\b/u.test(
            file.text,
          )
        ) {
          add(file, 1, 'owner hydration must use or inject loadStateForResume');
        }
      } else if (directLoad.length > 0 && !strictV4) {
        add(
          file,
          directLoad[0] ?? 1,
          'loadState path is not classified as owner hydration or strict-v4 observation',
        );
      }
    }
  }

  return findings;
}

export function scanT065Invariants(
  root = 'src',
  rule: T065Rule | 'all' = 'all',
): readonly T065Finding[] {
  const files = sourceFiles(root);
  const rules = rule === 'all' ? T065_RULES : [rule];
  const findings = rules.flatMap((currentRule) => scanT065Rule(files, currentRule));
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule}|${finding.path}|${finding.line}|${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type ExecGateCommand = (command: string) => string;
type LogLine = (line?: string) => void;

export function getInvariantGates(id: string): readonly Gate[] {
  return gates.filter((gate) => gate.id === id).map((gate) => ({ ...gate }));
}

function execGateCommand(command: string): string {
  const result = spawnSync('/bin/bash', ['-o', 'pipefail', '-c', command], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;
  const stderr = result.stderr.trim();
  if (result.status !== 0 || result.signal !== null || stderr.length > 0) {
    throw new Error(stderr || `command exited with ${result.status ?? result.signal}`);
  }
  return result.stdout.trim();
}

export function runInvariantGates(
  gatesToRun: readonly Gate[] = gates,
  execCommand: ExecGateCommand = execGateCommand,
  log: LogLine = console.log,
): number {
  let failed = 0;

  for (const gate of gatesToRun) {
    let count: number;
    try {
      const output = execCommand(gate.command).trim();
      if (!/^\d+$/.test(output)) {
        log(
          `  ✗ [${gate.id}] ${gate.description}: invalid output "${output}" (expected ${gate.expected}) FAIL`,
        );
        failed++;
        continue;
      }
      count = parseInt(output, 10);
    } catch {
      log(`  ✗ [${gate.id}] ${gate.description}: command failed (expected ${gate.expected}) FAIL`);
      failed++;
      continue;
    }

    const pass = count === gate.expected;
    const status = pass ? 'PASS' : 'FAIL';
    const symbol = pass ? '✓' : '✗';
    log(
      `  ${symbol} [${gate.id}] ${gate.description}: ${count} (expected ${gate.expected}) ${status}`,
    );

    if (!pass) failed++;
  }

  return failed;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const scanIndex = process.argv.indexOf('--t065-scan');
  if (scanIndex !== -1) {
    const root = process.argv[scanIndex + 1];
    const requestedRule = process.argv[process.argv.indexOf('--rule') + 1] ?? 'all';
    if (
      root === undefined ||
      (requestedRule !== 'all' && !T065_RULES.includes(requestedRule as T065Rule))
    ) {
      console.error('Usage: check-invariants.ts --t065-scan <src-root> [--rule <rule>]');
      process.exit(2);
    }
    for (const finding of scanT065Invariants(root, requestedRule as T065Rule | 'all')) {
      console.log(`${finding.path}:${finding.line}: ${finding.message}`);
    }
    process.exit(0);
  }

  const failed = runInvariantGates();

  console.log();
  if (failed > 0) {
    console.log(`${failed} gate(s) failed.`);
    process.exit(1);
  } else {
    console.log(`All ${gates.length} gates passed.`);
  }
}
