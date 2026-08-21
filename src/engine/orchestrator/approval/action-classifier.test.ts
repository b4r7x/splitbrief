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

describe('classifyAction — package_change via manifest file write', () => {
  it.each([
    { desc: 'write package.json', actionClass: 'package_change', tier: 'confirm' },
    { desc: 'edit pnpm-lock.yaml', actionClass: 'package_change', tier: 'confirm' },
  ])('$desc → $actionClass/$tier', ({ desc, actionClass, tier }) => {
    const result = classifyAction(make(desc));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — command-shaped descriptions are not command-classified', () => {
  it.each([
    'rm -rf dist/',
    'git reset --hard HEAD',
    'git push --force origin main',
    'knex migrate',
    'npm publish',
    'curl https://api.example.com/data',
    'npm install lodash',
  ])('%s is never destructive/network/package_change/validation', (desc) => {
    const { actionClass } = classifyAction(make(desc));
    expect(['destructive', 'network', 'package_change', 'validation']).not.toContain(actionClass);
  });
});

describe('classifyAction — config-file writes are scope-classified, not validation', () => {
  it.each([
    {
      desc: 'modify tsconfig.json',
      overrides: { taskInBounds: ['src/**'] },
      actionClass: 'write_out_of_scope',
      tier: 'sticky',
    },
    {
      desc: 'edit tsconfig.json',
      overrides: { taskInBounds: ['tsconfig.json'] },
      actionClass: 'write_in_scope',
      tier: 'auto',
    },
    {
      desc: 'modify vitest.config.ts',
      overrides: { taskInBounds: ['src/**'] },
      actionClass: 'write_out_of_scope',
      tier: 'sticky',
    },
  ])('$desc → $actionClass/$tier', ({ desc, overrides, actionClass, tier }) => {
    const result = classifyAction(make(desc, overrides));
    expect(result).toEqual({ actionClass, tier });
  });
});

describe('classifyAction — read', () => {
  it.each([{ desc: 'read src/core/paths.ts', actionClass: 'read', tier: 'auto' }])(
    '$desc → $actionClass/$tier',
    ({ desc, actionClass, tier }) => {
      const result = classifyAction(make(desc));
      expect(result).toEqual({ actionClass, tier });
    },
  );
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

describe('classifyAction — prose scope entries', () => {
  it('prose scope entry ("In bounds: `src/x.ts`") classifies the brief-authorized file as in-scope', () => {
    const result = classifyAction(
      make('edit src/x.ts', {
        taskFile: 'src/main.ts',
        taskInBounds: ['In bounds: `src/x.ts`'],
        dependsOnFiles: [],
      }),
    );
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('prose scope entry without a path authorizes nothing', () => {
    const result = classifyAction(
      make('edit src/unrelated/other.ts', {
        taskInBounds: ['Concrete change this brief is allowed to make'],
      }),
    );
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });
});

describe('classifyAction — control plane', () => {
  it.each([
    { taskFile: '.git/config', desc: 'create .git/config' },
    { taskFile: '.git/hooks/pre-commit', desc: 'write .git/hooks/pre-commit' },
    { taskFile: '.splitbrief/config.yaml', desc: 'modify .splitbrief/config.yaml' },
  ])('$taskFile → destructive/confirm, never write_in_scope/auto', ({ taskFile, desc }) => {
    const result = classifyAction(make(desc, { taskFile, taskInBounds: [taskFile] }));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });

  it('control-plane target stays destructive even when allowedPaths would include it', () => {
    const result = classifyAction(
      make('write .git/config', {
        taskFile: '.git/config',
        taskInBounds: ['.git/**'],
        allowedPaths: ['.git/**'],
      }),
    );
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
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
    const result = classifyAction(make('write package.json'), {
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
});
