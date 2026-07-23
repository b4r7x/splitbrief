import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function seedValidationProject(projectDir: string, expectedMarker = 'from-retry'): void {
  writeFileSync(
    join(projectDir, 'validate.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const content = readFileSync('src/loop.ts', 'utf-8');",
      `if (!content.includes(${JSON.stringify(expectedMarker)})) {`,
      `  console.error(${JSON.stringify(`expected ${expectedMarker} implementation`)});`,
      '  process.exit(1);',
      '}',
    ].join('\n') + '\n',
    'utf-8',
  );
}
