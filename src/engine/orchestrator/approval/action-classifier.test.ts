import { describe, it, expect } from 'vitest';
import { classifyAction } from './action-classifier.js';
import type { ClassifyInput } from './action-classifier.js';

const baseInput: ClassifyInput = {
  actionDescription: '',
  taskFile: 'src/feature/foo.ts',
  taskInBounds: ['src/feature/**'],
  dependsOnFiles: ['src/shared/utils.ts'],
  projectDir: '/project',
};

function make(desc: string, overrides?: Partial<ClassifyInput>): ClassifyInput {
  return { ...baseInput, actionDescription: desc, ...overrides };
}

describe('classifyAction — destructive', () => {
  it.each([
    { desc: 'rm -rf dist/', actionClass: 'destructive', tier: 'confirm' },
    { desc: 'git reset --hard HEAD', actionClass: 'destructive', tier: 'confirm' },
    { desc: 'git push --force origin main', actionClass: 'destructive', tier: 'confirm' },
    { desc: 'knex migrate', actionClass: 'destructive', tier: 'confirm' },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — network', () => {
  it.each([
    { desc: 'npm publish', actionClass: 'network', tier: 'confirm' },
    { desc: 'curl https://api.example.com/data', actionClass: 'network', tier: 'confirm' },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — package_change', () => {
  it.each([
    { desc: 'npm install lodash', actionClass: 'package_change', tier: 'confirm' },
    { desc: 'write package.json', actionClass: 'package_change', tier: 'confirm' },
    {
      desc: 'npm install lodash then edit src/feature/foo.ts',
      actionClass: 'package_change',
      tier: 'confirm',
    },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — validation', () => {
  it.each([
    { desc: 'npm run tsc', actionClass: 'validation', tier: 'auto' },
    { desc: 'npm run typecheck', actionClass: 'validation', tier: 'auto' },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — read', () => {
  it.each([
    { desc: 'read src/core/paths.ts', actionClass: 'read', tier: 'auto' },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — write_in_scope', () => {
  it.each([
    { desc: 'modify src/feature/foo.ts', actionClass: 'write_in_scope', tier: 'auto' },
    {
      desc: 'edit src/feature/foo.ts to add a method',
      actionClass: 'write_in_scope',
      tier: 'auto',
    },
    { desc: 'edit src/shared/utils.ts', actionClass: 'write_in_scope', tier: 'auto' },
    { desc: 'create src/feature/bar.ts', actionClass: 'write_in_scope', tier: 'auto' },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — write_out_of_scope', () => {
  it.each([
    { desc: 'edit src/unrelated/other.ts', actionClass: 'write_out_of_scope', tier: 'sticky' },
    { desc: 'write the configuration to disk', actionClass: 'write_out_of_scope', tier: 'sticky' },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — tier overrides', () => {
  it('write_out_of_scope → confirm via tierOverrides', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts'), {
      write_out_of_scope: 'confirm',
    });
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'confirm' });
  });

  it('package_change → sticky via tierOverrides', () => {
    const result = classifyAction(make('npm install lodash'), {
      package_change: 'sticky',
    });
    expect(result).toEqual({ actionClass: 'package_change', tier: 'sticky' });
  });
});

describe('classifyAction — allowedPaths', () => {
  it('write to file matching allowedPaths → write_in_scope/auto', () => {
    const result = classifyAction(
      make('edit src/components/button.ts', {
        taskInBounds: ['src/feature/**'],
        allowedPaths: ['src/**'],
      }),
    );
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('write to file NOT matching allowedPaths → write_out_of_scope/sticky', () => {
    const result = classifyAction(
      make('edit scripts/deploy.sh', {
        taskInBounds: ['src/feature/**'],
        allowedPaths: ['src/**'],
      }),
    );
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('no allowedPaths → existing behavior unchanged', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts'));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths undefined → existing behavior unchanged', () => {
    const result = classifyAction(
      make('edit src/unrelated/other.ts', {
        allowedPaths: undefined,
      }),
    );
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths empty array → existing behavior unchanged', () => {
    const result = classifyAction(
      make('edit src/unrelated/other.ts', {
        allowedPaths: [],
      }),
    );
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths + taskInBounds union: either match = in-scope', () => {
    const result = classifyAction(
      make('edit tests/unit/foo.test.ts', {
        taskInBounds: ['src/feature/**'],
        allowedPaths: ['tests/**'],
      }),
    );
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('allowedPaths with extension wildcard', () => {
    const result = classifyAction(
      make('create docs/guide.md', {
        taskInBounds: ['src/**'],
        allowedPaths: ['*.md'],
      }),
    );
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('allowedPaths respects tier overrides on write_in_scope', () => {
    const result = classifyAction(
      make('edit src/components/button.ts', {
        taskInBounds: [],
        allowedPaths: ['src/**'],
      }),
      { write_in_scope: 'sticky' },
    );
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'sticky' });
  });

  it('destructive action in allowed path still classified as destructive', () => {
    const result = classifyAction(
      make('rm -rf src/old/', {
        allowedPaths: ['src/**'],
      }),
    );
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });
});
