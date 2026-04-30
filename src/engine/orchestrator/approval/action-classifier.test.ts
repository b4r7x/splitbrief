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
  it('rm -rf dist/ → destructive/confirm', () => {
    const result = classifyAction(make('rm -rf dist/'));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });

  it('git reset --hard HEAD → destructive/confirm', () => {
    const result = classifyAction(make('git reset --hard HEAD'));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });

  it('git push --force origin main → destructive/confirm', () => {
    const result = classifyAction(make('git push --force origin main'));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });

  it('knex migrate → destructive/confirm', () => {
    const result = classifyAction(make('knex migrate'));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });
});

describe('classifyAction — network', () => {
  it('npm publish → network/confirm', () => {
    const result = classifyAction(make('npm publish'));
    expect(result).toEqual({ actionClass: 'network', tier: 'confirm' });
  });

  it('curl https://api.example.com/data → network/confirm', () => {
    const result = classifyAction(make('curl https://api.example.com/data'));
    expect(result).toEqual({ actionClass: 'network', tier: 'confirm' });
  });
});

describe('classifyAction — package_change', () => {
  it('npm install lodash → package_change/confirm', () => {
    const result = classifyAction(make('npm install lodash'));
    expect(result).toEqual({ actionClass: 'package_change', tier: 'confirm' });
  });

  it('write package.json → package_change/confirm', () => {
    const result = classifyAction(make('write package.json'));
    expect(result).toEqual({ actionClass: 'package_change', tier: 'confirm' });
  });
});

describe('classifyAction — validation', () => {
  it('npm run tsc → validation/auto', () => {
    const result = classifyAction(make('npm run tsc'));
    expect(result).toEqual({ actionClass: 'validation', tier: 'auto' });
  });

  it('npm run typecheck → validation/auto', () => {
    const result = classifyAction(make('npm run typecheck'));
    expect(result).toEqual({ actionClass: 'validation', tier: 'auto' });
  });
});

describe('classifyAction — read', () => {
  it('read src/core/paths.ts → read/auto', () => {
    const result = classifyAction(make('read src/core/paths.ts'));
    expect(result).toEqual({ actionClass: 'read', tier: 'auto' });
  });
});

describe('classifyAction — write_in_scope', () => {
  it('modify taskFile → write_in_scope/auto', () => {
    const result = classifyAction(make('modify src/feature/foo.ts'));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('write to taskFile → write_in_scope/auto', () => {
    const result = classifyAction(make('edit src/feature/foo.ts to add a method'));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('write to file in dependsOnFiles → write_in_scope/auto', () => {
    const result = classifyAction(make('edit src/shared/utils.ts'));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('write to file matching taskInBounds glob → write_in_scope/auto', () => {
    const result = classifyAction(make('create src/feature/bar.ts'));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });
});

describe('classifyAction — write_out_of_scope', () => {
  it('write to src/unrelated/other.ts → write_out_of_scope/sticky', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts'));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('write with no extractable path → write_out_of_scope/sticky', () => {
    const result = classifyAction(make('write the configuration to disk'));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
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

describe('classifyAction — order check', () => {
  it('npm install ... edit src/foo.ts → package_change (not write)', () => {
    const result = classifyAction(make('npm install lodash then edit src/feature/foo.ts'));
    expect(result).toEqual({ actionClass: 'package_change', tier: 'confirm' });
  });
});

describe('classifyAction — allowedPaths', () => {
  it('write to file matching allowedPaths → write_in_scope/auto', () => {
    const result = classifyAction(make('edit src/components/button.ts', {
      taskInBounds: ['src/feature/**'],
      allowedPaths: ['src/**'],
    }));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('write to file NOT matching allowedPaths → write_out_of_scope/sticky', () => {
    const result = classifyAction(make('edit scripts/deploy.sh', {
      taskInBounds: ['src/feature/**'],
      allowedPaths: ['src/**'],
    }));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('no allowedPaths → existing behavior unchanged', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts'));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths undefined → existing behavior unchanged', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts', {
      allowedPaths: undefined,
    }));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths empty array → existing behavior unchanged', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts', {
      allowedPaths: [],
    }));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths + taskInBounds union: either match = in-scope', () => {
    const result = classifyAction(make('edit tests/unit/foo.test.ts', {
      taskInBounds: ['src/feature/**'],
      allowedPaths: ['tests/**'],
    }));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('allowedPaths with extension wildcard', () => {
    const result = classifyAction(make('create docs/guide.md', {
      taskInBounds: ['src/**'],
      allowedPaths: ['*.md'],
    }));
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
    const result = classifyAction(make('rm -rf src/old/', {
      allowedPaths: ['src/**'],
    }));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });
});
