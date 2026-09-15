const { readdirSync } = require('node:fs');

const features = readdirSync('src/features', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      severity: 'error',
      from: { orphan: true, pathNot: '^src/main\\.ts$' },
      to: {},
    },
    {
      name: 'shared-stays-independent',
      severity: 'error',
      from: { path: '^src/lib/' },
      to: { path: '^src/(features/|main\\.ts$)' },
    },
    {
      name: 'features-do-not-import-entry',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/main\\.ts$' },
    },
    {
      name: 'no-internal-barrels',
      severity: 'error',
      from: {},
      to: { path: '(^|/)index\\.ts$' },
    },
    ...features.map((feature) => ({
      name: `${feature}-has-no-cross-feature-imports`,
      severity: 'error',
      from: { path: `^src/features/${feature}/` },
      to: { path: '^src/features/', pathNot: `^src/features/${feature}/` },
    })),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.ts$' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: 'specify',
    enhancedResolveOptions: {
      extensions: ['.ts', '.js'],
      conditionNames: ['import', 'types', 'default'],
    },
    includeOnly: '^src/',
  },
};
