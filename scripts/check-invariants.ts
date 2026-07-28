import { spawnSync } from 'node:child_process';
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
    command: `{ rg -n -P "[)\\]A-Za-z0-9_>] as [A-Z][A-Za-z0-9_]*(?=[;),<\\].}>]|$|\\[)" src/ -g "*.ts" -g "*.tsx" -g "!**/*.test.ts" -g "!**/*.test.tsx" | rg -v "\\bas const\\b|\\bas unknown\\b| as Extract<" | rg -v "^src/(stores/use-stores|engine/hooks/substitute|utils/error)\\.ts:" || true; } | wc -l`,
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
];

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
  const failed = runInvariantGates();

  console.log();
  if (failed > 0) {
    console.log(`${failed} gate(s) failed.`);
    process.exit(1);
  } else {
    console.log(`All ${gates.length} gates passed.`);
  }
}
