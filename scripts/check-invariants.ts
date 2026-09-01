import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { type Gate, gates } from './invariants/gates.js';
import { type T065Rule, T065_RULES, scanT065Invariants } from './invariants/t065-scan.js';

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
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      log(
        `  ✗ [${gate.id}] ${gate.description}: command failed: ${reason} (expected ${gate.expected}) FAIL`,
      );
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
    const ruleIndex = process.argv.indexOf('--rule');
    const requestedRule = ruleIndex === -1 ? 'all' : (process.argv[ruleIndex + 1] ?? 'all');
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
