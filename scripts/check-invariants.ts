import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface Gate {
  id: string;
  description: string;
  command: string;
  expected: number;
}

const gates: Gate[] = [
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
    description: 'No raw throw new Error in engine/lib/cli',
    command:
      '{ rg "throw new Error" src/engine/ src/lib/ src/cli/ | rg -v \'\\.test\\.\' || true; } | wc -l',
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
    description: 'simple-git only in src/lib/git.ts',
    command:
      "{ rg \"from 'simple-git'\" src/ --glob '!**/*.test.ts' | rg -v '^src/lib/git.ts:' || true; } | wc -l",
    expected: 0,
  },
  {
    id: '7',
    description: 'No global env mutation in agent-sdk-backend',
    command:
      '{ rg "process\\.env(?:\\.[A-Z_]+|\\[[\'\\"\'][A-Z_]+[\'\\"]\\])\\s*=" src/engine/runners/agent-sdk-backend.ts || true; } | wc -l',
    expected: 0,
  },
  {
    id: '8',
    description: 'Zero runtime classes in production source (error subclasses sanctioned, D2)',
    command:
      '{ rg "\\bclass\\s+\\w+" src/ --glob \'!**/*.test.ts\' --glob \'!**/*.test.tsx\' | rg -v "\\bextends Error\\b" || true; } | wc -l',
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
    command: `{ rg -n -P "[)\\]A-Za-z0-9_>] as [A-Z][A-Za-z0-9_]*(?=[;),<\\].}>]|$|\\[)" src/ -g "*.ts" -g "*.tsx" -g "!**/*.test.ts" -g "!**/*.test.tsx" | rg -v "\\bas const\\b|\\bas unknown\\b| as Extract<" | rg -v "^src/(stores/use-stores|engine/hooks/substitute|engine/hooks/dispatch|utils/error)\\.ts:" || true; } | wc -l`,
    expected: 0,
  },
  {
    id: '18',
    description: 'No dead exports/files (knip)',
    command:
      '{ npx knip --no-progress --no-config-hints --tags=-lintignore --include exports,types,files --reporter compact 2>/dev/null | rg . || true; } | wc -l',
    expected: 0,
  },
  {
    id: '19',
    description: 'No runtime circular deps + layer-direction graph (dependency-cruiser)',
    command:
      '{ npx depcruise --config .dependency-cruiser.cjs --output-type err-long src 2>/dev/null | rg "^\\s+error " || true; } | wc -l',
    expected: 0,
  },
  {
    id: '20',
    description: 'Test files must import testing/helpers via #testing alias, not relative paths',
    command:
      '{ rg -n "from [\'\\"]\\.\\.?/.*testing/helpers" src/ -g "*.test.ts" -g "*.test.tsx" || true; } | wc -l',
    expected: 0,
  },
];

type ExecGateCommand = (command: string) => string;
type LogLine = (line?: string) => void;

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
