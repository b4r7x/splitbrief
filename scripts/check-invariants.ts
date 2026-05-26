import { execSync } from 'node:child_process';

interface Gate {
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
    command: 'rg "z\\.infer" src/core/types/ | wc -l',
    expected: 0,
  },
  {
    id: '3',
    description: 'Zero memoization / imperative handles',
    command: 'rg "useMemo|useCallback|React\\.memo|forwardRef|useImperativeHandle" src/ | wc -l',
    expected: 0,
  },
  {
    id: '4',
    description: 'No raw throw new Error in engine/lib/cli',
    command: "rg \"throw new Error\" src/engine/ src/lib/ src/cli/ | rg -v '\\.test\\.' | wc -l",
    expected: 0,
  },
  {
    id: '5',
    description: 'No raw setter on store facade',
    command: 'rg "^\\s*set:\\s*store\\.set" src/stores/ | wc -l',
    expected: 0,
  },
  {
    id: '6',
    description: 'simple-git only in src/lib/git.ts',
    command: "rg \"from 'simple-git'\" src/ --glob '!**/*.test.ts' | rg -v '^src/lib/git.ts:' | wc -l",
    expected: 0,
  },
  {
    id: '7',
    description: 'No global env mutation in agent-sdk-backend',
    command: "rg \"process\\.env(?:\\.[A-Z_]+|\\[['\\\"'][A-Z_]+['\\\"]\\])\\s*=\" src/engine/agent-sdk-backend.ts | wc -l",
    expected: 0,
  },
  {
    id: '8',
    description: 'Zero runtime classes in production source',
    command: "rg \"\\bclass\\s+\\w+\" src/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx' | wc -l",
    expected: 0,
  },
  {
    id: '9',
    description: 'No cross-feature imports',
    command: "rg \"from '\\.\\./(\\.\\./)features/\" src/features/ | wc -l",
    expected: 0,
  },
  {
    id: '10',
    description: 'No callbacks.onEvent (post-migration guard)',
    command: 'grep -rn "callbacks\\.onEvent" src/ | wc -l',
    expected: 0,
  },
  {
    id: '11',
    description: 'No OrchestratorEvent (post-migration guard)',
    command: 'grep -rn "OrchestratorEvent\\b" src/ | wc -l',
    expected: 0,
  },
  {
    id: '12',
    description: 'Engine must not import from features',
    command: "grep -rln 'from.*features' src/engine | grep -v '\\.test\\.' | wc -l",
    expected: 0,
  },
  {
    id: '12b',
    description: 'Engine must not import react or ink',
    command: "rg -ln \"from 'react'|from 'ink'\" src/engine/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx' | wc -l",
    expected: 0,
  },
  {
    id: '12c',
    description: 'Engine must not import from src/components/ or src/hooks/ or src/cli/',
    command: "rg -n \"from '\\.\\./\\.\\./\\.\\./(hooks|components|cli)/\" src/engine/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx' | wc -l",
    expected: 0,
  },
  {
    id: '13',
    description: 'No TuiEvent (post-migration guard)',
    command: 'grep -rn "\\bTuiEvent\\b" src/ | wc -l',
    expected: 0,
  },
  {
    id: '14',
    description: 'React architecture refactor guard',
    command: "rg -n -e \"components/input-bar\" -e \"core/slash-commands\" -e \"features/tool-picker\" -e \"hooks/use-app-keys\" -e \"workflow/components/command-palette-overlay\" -e \"engine/palette-aggregate\" -e \"InputBar\" -e \"toPaletteItems\" -e \"slashItems\" -e \"source: 'slash'\" -e \"'slash:'\" src CLAUDE.md docs --glob '*.md' --glob '!docs/INVARIANTS.md' --glob '!docs/superpowers/**' --glob '!docs/audits/**' | wc -l",
    expected: 0,
  },
  {
    id: '15',
    description: 'No hidden ASCII control bytes in source',
    command: "find src -type f \\( -name '*.ts' -o -name '*.tsx' \\) -exec perl -ne 'while (/([\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F])/g) { printf \"%s:%d:%d:U+%04X\\n\", $ARGV, $., pos($_), ord($1) } close ARGV if eof' {} + | wc -l",
    expected: 0,
  },
  {
    id: '16',
    description: 'Relative imports must use .js extension',
    command: "rg -n \"from '\\.\\.?/\" src/ --glob '*.ts' --glob '*.tsx' --glob '!**/*.test.ts' --glob '!**/*.test.tsx' | rg -v \"\\.js'|\\.json'\" | wc -l",
    expected: 0,
  },
];

let failed = 0;

for (const gate of gates) {
  let count: number;
  try {
    const output = execSync(gate.command, {
      shell: '/bin/bash',
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    count = parseInt(output, 10) || 0;
  } catch {
    count = 0;
  }

  const pass = count === gate.expected;
  const status = pass ? 'PASS' : 'FAIL';
  const symbol = pass ? '✓' : '✗';
  console.log(`  ${symbol} [${gate.id}] ${gate.description}: ${count} (expected ${gate.expected}) ${status}`);

  if (!pass) failed++;
}

console.log();
if (failed > 0) {
  console.log(`${failed} gate(s) failed.`);
  process.exit(1);
} else {
  console.log(`All ${gates.length} gates passed.`);
}
