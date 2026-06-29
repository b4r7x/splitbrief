/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'Runtime circular dependencies make the module graph impossible to reason about and break tree-shaking. Zero exist today; this gate keeps it that way. Type-only cycles (e.g. a Zod schema referencing its own inferred type) are erased at compile time and are excluded via viaOnly.dependencyTypesNot.',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'utils-is-a-leaf',
      comment:
        'src/utils/ is the leaf of the import graph (LAYERS.md): it may only depend on Node/npm and other utils.',
      severity: 'error',
      from: { path: '^src/utils/' },
      to: { path: '^src/(lib|core|engine|stores|features|components|hooks|app|cli)/' },
    },
    {
      name: 'lib-below-domain',
      comment:
        'src/lib/ wraps infrastructure and must not know domain or UI (LAYERS.md). It may import utils and other lib only.',
      severity: 'error',
      from: { path: '^src/lib/' },
      to: { path: '^src/(core|engine|stores|features|components|hooks|app|cli)/' },
    },
    {
      name: 'core-below-engine-and-ui',
      comment:
        'src/core/ is UI- and orchestration-agnostic (LAYERS.md). It may import utils, lib, and core siblings only.',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/(engine|stores|features|components|hooks|app|cli)/' },
    },
    {
      name: 'engine-below-ui',
      comment:
        'src/engine/ has zero React/Ink and zero UI imports (LAYERS.md, INVARIANTS.md gate 12/12b/12c). It may import utils, lib, core, and engine siblings only; stores sit above engine (the sanctioned channel is stores importing engine types, never the reverse).',
      severity: 'error',
      from: { path: '^src/engine/' },
      to: { path: '^src/(stores|features|components|hooks|app|cli)/' },
    },
    {
      name: 'stores-engine-type-only',
      comment:
        'src/stores/ is the engine<->UI channel (STORES.md). The only sanctioned edge into engine is type-only; a value import is forbidden.',
      severity: 'error',
      from: { path: '^src/stores/' },
      to: { path: '^src/engine/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'stores-below-ui',
      comment:
        'src/stores/ depends on utils, core, and lib only (LAYERS.md). It must not import UI or app/cli.',
      severity: 'error',
      from: { path: '^src/stores/' },
      to: { path: '^src/(features|components|hooks|app|cli)/' },
    },
    {
      name: 'components-no-features',
      comment:
        'Shared src/components/ must not import a vertical feature slice (LAYERS.md, INVARIANTS.md gate 9).',
      severity: 'error',
      from: { path: '^src/components/' },
      to: { path: '^src/features/' },
    },
    {
      name: 'hooks-no-features',
      comment: 'Shared src/hooks/ must not import a vertical feature slice (LAYERS.md).',
      severity: 'error',
      from: { path: '^src/hooks/' },
      to: { path: '^src/features/' },
    },
    {
      name: 'features-below-app-cli',
      comment:
        'Feature slices are wired only at the app/ shell — app/router.tsx composes the page files and app/root.tsx mounts the tree (LAYERS.md). They must not reach up into app/ or cli/.',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/(app|cli)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.(ts|tsx)$' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: 'specify',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },
    includeOnly: '^src/',
  },
};
