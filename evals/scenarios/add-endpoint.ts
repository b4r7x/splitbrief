import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

const healthEndpointCandidates = ['src/routes/health.ts', 'src/health.ts', 'src/api/health.ts'];

function fileContains(dir: string, path: string, substring: string): QualityCheckResult {
  const full = join(dir, path);
  if (!existsSync(full)) {
    return { passed: false, detail: `${path} not found` };
  }

  const content = readFileSync(full, 'utf-8');
  return content.includes(substring)
    ? { passed: true, detail: `${path} contains "${substring}"` }
    : { passed: false, detail: `${path} does not contain "${substring}"` };
}

function testsPass(dir: string): QualityCheckResult {
  try {
    execSync('npm test', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    return { passed: true, detail: 'npm test passed' };
  } catch {
    return { passed: false, detail: 'npm test failed' };
  }
}

function findCandidateFile(dir: string): string | undefined {
  return healthEndpointCandidates.find((path) => existsSync(join(dir, path)));
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'health endpoint file exists',
    check: async (dir) => {
      const path = findCandidateFile(dir);
      return path
        ? { passed: true, detail: `Found ${path}` }
        : { passed: false, detail: 'No health endpoint file found' };
    },
  },
  {
    name: 'health endpoint exports handler',
    check: async (dir) => {
      const path = findCandidateFile(dir);
      if (!path) {
        return { passed: false, detail: 'No health endpoint file found' };
      }

      const result = fileContains(dir, path, 'export');
      return result.passed ? result : { passed: false, detail: `${path} does not export a handler` };
    },
  },
  {
    name: 'health endpoint returns status ok',
    check: async (dir) => {
      for (const path of healthEndpointCandidates) {
        const result = fileContains(dir, path, 'status');
        if (result.passed) {
          return result;
        }
      }

      return { passed: false, detail: 'No file contains "status"' };
    },
  },
  {
    name: 'health endpoint returns uptime',
    check: async (dir) => {
      for (const path of healthEndpointCandidates) {
        const result = fileContains(dir, path, 'uptime');
        if (result.passed) {
          return result;
        }
      }

      return { passed: false, detail: 'No file contains "uptime"' };
    },
  },
  {
    name: 'tests pass after implementation',
    check: async (dir) => testsPass(dir),
  },
];

export const addEndpointScenario: EvalScenario = {
  id: 'add-endpoint',
  name: 'Add REST endpoint',
  feature: 'Add a GET /api/health endpoint that returns { status: "ok", uptime: process.uptime() }',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/add-endpoint'),
  mode: 'quick',
  qualityChecks,
};
