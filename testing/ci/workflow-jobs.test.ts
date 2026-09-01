import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const REPO_ROOT = join(import.meta.dirname, '../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github/workflows');

type WorkflowStep = { run?: string };
type WorkflowJob = {
  strategy?: { matrix?: { shard?: number[] } };
  steps: WorkflowStep[];
};
type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
};

function readWorkflow(file: string): string {
  return readFileSync(join(WORKFLOW_DIR, file), 'utf-8');
}

function parseWorkflow(file: string): Workflow {
  return YAML.parse(readWorkflow(file)) as Workflow;
}

function runCommands(job: WorkflowJob): string[] {
  return job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
}

function jobOf(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  if (job === undefined) throw new Error(`workflow job not found: ${name}`);
  return job;
}

const ciText = readWorkflow('ci.yml');
const ci = parseWorkflow('ci.yml');

describe('CI workflow topology', () => {
  it('splits the push gate into independent parallel jobs', () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(['e2e-replay', 'smoke', 'static', 'unit']);
  });

  it('shards the unit run four ways without coverage instrumentation', () => {
    const unit = jobOf(ci, 'unit');
    expect(unit.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(runCommands(unit)).toContain(`npm test -- --shard=\${{ matrix.shard }}/4`);
  });

  it('keeps coverage off the per-push critical path', () => {
    expect(ciText).not.toContain('coverage');
    expect(ciText).not.toContain('test-ci');
  });

  it('runs coverage nightly with the thresholds untouched', () => {
    const nightly = parseWorkflow('nightly-coverage.yml');
    expect(Object.hasOwn(nightly.on, 'workflow_dispatch')).toBe(true);
    expect(nightly.on.schedule).toEqual([{ cron: '0 4 * * *' }]);
    expect(runCommands(jobOf(nightly, 'coverage'))).toContain('npm run test:coverage');

    const vitestConfig = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf-8');
    expect(vitestConfig).toContain(
      'thresholds: { statements: 50, branches: 40, functions: 50, lines: 55 }',
    );
  });

  it('keeps every automated workflow clear of the paid live tier', () => {
    const files = readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readWorkflow(file);
      expect(text, file).not.toContain('SPLITBRIEF_REAL_CLI');
      expect(text, file).not.toContain('test:e2e:live');
    }
  });
});
