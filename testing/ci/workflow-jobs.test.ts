import { readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import vitestConfig from '../../vitest.config.js';

const REPO_ROOT = join(import.meta.dirname, '../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github/workflows');

type WorkflowStep = {
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  env?: Record<string, string>;
};
type WorkflowJob = {
  'timeout-minutes'?: number;
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

function aptInstall(job: WorkflowJob): string | undefined {
  return runCommands(job).find((command) => command.startsWith('sudo apt-get update'));
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
    expect(Object.keys(ci.jobs).sort()).toEqual([
      'e2e-replay',
      'integration',
      'smoke',
      'static',
      'unit',
    ]);
  });

  it('shards the unit run two ways with CI disabled', () => {
    const unit = jobOf(ci, 'unit');
    const command = `npm test -- --shard=\${{ matrix.shard }}/2`;
    expect(unit.strategy?.matrix?.shard).toEqual([1, 2]);
    expect(runCommands(unit)).toContain(command);
    expect(unit.steps.find((step) => step.run === command)?.env?.CI).toBe('false');
  });

  it('shards the integration run four ways on a full clone with CI disabled', () => {
    const integration = jobOf(ci, 'integration');
    const command = `npm run test:integration -- --shard=\${{ matrix.shard }}/4`;
    expect(integration.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(runCommands(integration)).toContain(command);
    expect(integration.steps.find((step) => step.run === command)?.env?.CI).toBe('false');
    const checkout = integration.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  it('installs the system tools each test job needs', () => {
    expect(aptInstall(jobOf(ci, 'static'))).toMatch(/install -y ripgrep$/);
    expect(aptInstall(jobOf(ci, 'unit'))).toMatch(/install -y ripgrep$/);
    expect(aptInstall(jobOf(ci, 'integration'))).toMatch(/install -y ripgrep bubblewrap socat$/);
    expect(aptInstall(jobOf(ci, 'e2e-replay'))).toMatch(/install -y bubblewrap socat$/);
  });

  it('caps vitest workers by the host cores in the config, not by a CI flag', () => {
    const projects = vitestConfig.test?.projects ?? [];
    const sharded = projects.flatMap((project) =>
      typeof project === 'object' && 'test' in project ? [project.test] : [],
    );
    expect(sharded.filter((test) => test?.name === 'unit' || test?.name === 'integration')).toEqual(
      [
        expect.not.objectContaining({ maxWorkers: expect.anything() }),
        expect.not.objectContaining({ maxWorkers: expect.anything() }),
      ],
    );
    expect(vitestConfig.test?.maxWorkers).toBe(Math.min(4, availableParallelism()));
    for (const file of readdirSync(WORKFLOW_DIR)) {
      expect(readWorkflow(file), file).not.toContain('--maxWorkers');
    }
  });

  it('runs the website check only when the site, the pages it renders or the files its tests load change', () => {
    const website = parseWorkflow('website.yml');
    const triggers = ['push', 'pull_request'].map((event) => {
      const trigger = website.on[event];
      return typeof trigger === 'object' && trigger !== null && 'paths' in trigger
        ? trigger.paths
        : undefined;
    });
    const paths = [
      'website/**',
      'docs/**',
      'README.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'testing/helpers/scrub-credentials.ts',
      'testing/helpers/hermetic-env.ts',
      'src/utils/redact.ts',
      '.github/workflows/website.yml',
    ];
    expect(triggers).toEqual([paths, paths]);
    expect(runCommands(jobOf(website, 'website'))).toContain('npm run check');
  });

  it('gives static typechecking a 4 GB heap', () => {
    const typecheck = jobOf(ci, 'static').steps.find((step) => step.run === 'npm run typecheck');
    expect(typecheck?.env?.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });

  it('sets a positive timeout on every CI job', () => {
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
    }
  });

  it('keeps coverage off the per-push critical path', () => {
    expect(ciText).not.toContain('coverage');
    expect(ciText).not.toContain('test-ci');
  });

  it('runs coverage only on manual dispatch with the thresholds untouched', () => {
    const nightly = parseWorkflow('nightly-coverage.yml');
    expect(Object.hasOwn(nightly.on, 'workflow_dispatch')).toBe(true);
    expect(Object.hasOwn(nightly.on, 'schedule')).toBe(false);
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
