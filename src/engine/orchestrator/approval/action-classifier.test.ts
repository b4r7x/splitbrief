import { describe, it, expect } from 'vitest';
import { SCOPE_ENTRY_CASES } from '#testing/helpers/scope-entries.js';
import { classifyAction, extractActionPattern } from './action-classifier.js';
import type { ClassifyInput } from './action-classifier.js';

const baseInput: ClassifyInput = {
  actionDescription: '',
  taskFiles: ['src/feature/foo.ts'],
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
        taskFiles: ['src/main.ts'],
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
    const result = classifyAction(make(desc, { taskFiles: [taskFile], taskInBounds: [taskFile] }));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });

  it('control-plane target stays destructive even when allowedPaths would include it', () => {
    const result = classifyAction(
      make('write .git/config', {
        taskFiles: ['.git/config'],
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

describe('classifyAction — exact target path', () => {
  const declared = { taskFiles: ['src/app.ts'], taskInBounds: ['src/app.ts'], dependsOnFiles: [] };

  it.each([
    { targetPath: 'src/app.ts', actionClass: 'write_in_scope', tier: 'auto' },
    { targetPath: './src/app.ts', actionClass: 'write_in_scope', tier: 'auto' },
    { targetPath: '/project/src/app.ts', actionClass: 'write_in_scope', tier: 'auto' },
    { targetPath: 'src/app.ts.backup', actionClass: 'write_out_of_scope', tier: 'sticky' },
    { targetPath: 'other/src/app.ts', actionClass: 'write_out_of_scope', tier: 'sticky' },
    { targetPath: '/elsewhere/src/app.ts', actionClass: 'write_out_of_scope', tier: 'sticky' },
    {
      targetPath: '../project/src/app.ts.backup',
      actionClass: 'write_out_of_scope',
      tier: 'sticky',
    },
  ])('$targetPath → $actionClass/$tier', ({ targetPath, actionClass, tier }) => {
    const result = classifyAction(make(`write ${targetPath}`, { ...declared, targetPath }));
    expect(result).toEqual({ actionClass, tier });
  });

  it('a path containing a declared name is in scope only when independently declared', () => {
    expect(
      classifyAction(
        make('write src/app.ts.backup', {
          ...declared,
          taskInBounds: ['src/app.ts', 'src/app.ts.backup'],
          targetPath: 'src/app.ts.backup',
        }),
      ),
    ).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
    expect(
      classifyAction(
        make('write other/src/app.ts', {
          ...declared,
          allowedPaths: ['other/**'],
          targetPath: 'other/src/app.ts',
        }),
      ),
    ).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('keeps an exact path with spaces whole', () => {
    expect(
      classifyAction(
        make('write src/my app.ts', {
          taskFiles: ['src/my app.ts'],
          taskInBounds: [],
          dependsOnFiles: [],
          targetPath: 'src/my app.ts',
        }),
      ),
    ).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('package and control-plane policy still win over declared scope', () => {
    expect(
      classifyAction(
        make('write package.json', {
          taskFiles: ['package.json'],
          taskInBounds: ['package.json'],
          targetPath: 'package.json',
        }),
      ),
    ).toEqual({ actionClass: 'package_change', tier: 'confirm' });
    expect(
      classifyAction(
        make('write .git/config', {
          taskFiles: ['src/feature/foo.ts'],
          allowedPaths: ['.git/**'],
          targetPath: './.git/config',
        }),
      ),
    ).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });

  it('the target path, not the prose, decides the class', () => {
    expect(
      classifyAction(make('write src/feature/foo.ts', { targetPath: 'src/unrelated/other.ts' })),
    ).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('the sticky grant pattern is the exact target path', () => {
    expect(
      extractActionPattern(
        make('write src/app.ts.backup', { ...declared, targetPath: './src/app.ts.backup' }),
      ),
    ).toBe('src/app.ts.backup');
  });
});

describe('classifyAction — prose paths match whole tokens only', () => {
  const declared = { taskFiles: ['src/app.ts'], taskInBounds: [], dependsOnFiles: [] };

  it.each(['edit src/app.ts.backup', 'edit other/src/app.ts', 'edit `src/app.ts.backup`'])(
    '%s is not approved by the declared src/app.ts',
    (desc) => {
      expect(classifyAction(make(desc, declared))).toEqual({
        actionClass: 'write_out_of_scope',
        tier: 'sticky',
      });
    },
  );

  it('every path in the prose must be in scope', () => {
    expect(classifyAction(make('modify src/app.ts, src/unrelated/other.ts', declared))).toEqual({
      actionClass: 'write_out_of_scope',
      tier: 'sticky',
    });
    expect(
      classifyAction(
        make('modify src/app.ts, src/feature/foo.ts', {
          taskFiles: ['src/app.ts', 'src/feature/foo.ts'],
        }),
      ),
    ).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('a prose grant pattern is one whole path, or else the whole prose', () => {
    expect(extractActionPattern(make('edit src/app.ts.backup', declared))).toBe(
      'src/app.ts.backup',
    );
    expect(extractActionPattern(make('modify src/app.ts, src/other.ts', declared))).toBe(
      'modify src/app.ts, src/other.ts',
    );
  });
});

describe('classifyAction — declared scope entries', () => {
  it.each(SCOPE_ENTRY_CASES)(
    'same bullet auto-approves: $name',
    ({ entry, matches, nonMatches }) => {
      for (const file of matches) {
        expect(
          classifyAction(
            make(`edit ${file}`, {
              taskFiles: ['src/main.ts'],
              taskInBounds: [entry],
              dependsOnFiles: [],
            }),
          ),
        ).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
      }
      for (const file of nonMatches) {
        expect(
          classifyAction(
            make(`edit ${file}`, {
              taskFiles: ['src/main.ts'],
              taskInBounds: [entry],
              dependsOnFiles: [],
            }),
          ),
        ).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
      }
    },
  );

  it('every declared file is in scope, not only the anchor', () => {
    expect(
      classifyAction(
        make('edit src/second.ts', {
          taskFiles: ['src/main.ts', 'src/second.ts'],
          taskInBounds: [],
          dependsOnFiles: [],
        }),
      ),
    ).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });
});
