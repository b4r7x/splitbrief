import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ensureNodeModules } from './ensure-node-modules.js';
import { runNpmTest } from './shared.js';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

function executeHealthRequest(dir: string): QualityCheckResult {
  ensureNodeModules(dir);
  const script = [
    "import { handleRequest } from './src/server.ts';",
    "const response = handleRequest('GET', '/api/health');",
    "if (response.statusCode !== 200) throw new Error('Expected 200, got ' + response.statusCode);",
    "if (!response.body || typeof response.body !== 'object') throw new Error('Expected object response body');",
    "if (response.body.status !== 'ok') throw new Error('Expected status ok, got ' + response.body.status);",
    "if (typeof response.body.uptime !== 'number') throw new Error('Expected numeric uptime, got ' + typeof response.body.uptime);",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--eval', script], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  return result.status === 0
    ? { passed: true, detail: "handleRequest('GET', '/api/health') returned status ok with uptime" }
    : {
        passed: false,
        detail: `Health request failed: ${
          result.stderr.trim() ||
          result.stdout.trim() ||
          result.error?.message ||
          `exit ${result.status ?? 'unknown'}`
        }`,
      };
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'GET /api/health returns status ok with uptime',
    check: executeHealthRequest,
  },
  {
    name: 'tests pass after implementation',
    check: runNpmTest,
  },
];

export const addEndpointScenario: EvalScenario = {
  id: 'add-endpoint',
  name: 'Add REST endpoint',
  feature: 'Add a GET /api/health endpoint that returns { status: "ok", uptime: process.uptime() }',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/add-endpoint'),
  qualityChecks,
};
