import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function evaluateTsArtifact(filePath: string, expression: string): unknown {
  const moduleUrl = pathToFileURL(filePath).href;
  const script = [
    `const imported = await import(${JSON.stringify(moduleUrl)});`,
    "const mod = imported.default && typeof imported.default === 'object' ? { ...imported.default, ...imported } : imported;",
    `const result = ${expression};`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--eval', script], {
    encoding: 'utf-8',
  }));
}
