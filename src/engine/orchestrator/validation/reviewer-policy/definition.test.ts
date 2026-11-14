import { describe, expect, it } from 'vitest';
import { checkDefinition } from './definition.js';

const MAKE = {
  kind: 'task-file',
  runner: 'make',
  files: ['Makefile', 'makefile', 'GNUmakefile'],
  dirs: [],
};
const JUST = {
  kind: 'task-file',
  runner: 'just',
  files: ['justfile', 'Justfile', '.justfile'],
  dirs: [],
};
const RAKE = {
  kind: 'task-file',
  runner: 'rake',
  files: ['Rakefile', 'rakefile', 'Rakefile.rb', 'rakefile.rb'],
  dirs: ['rakelib'],
};

describe('checkDefinition', () => {
  it.each([
    ['python manage.py test', 'manage.py'],
    ['php artisan test', 'artisan'],
    ['node ./scripts/check.js --fast', 'scripts/check.js'],
    ['uv run python manage.py test', 'manage.py'],
    ['uv run --group dev python scripts/check.py', 'scripts/check.py'],
    ['uv run --group python python scripts/check.py', 'python'],
    ['conda run -n py312 python manage.py test', 'manage.py'],
    ['hatch run --verbose test:python manage.py test', 'manage.py'],
    ['uv run --group dev conda run -n py312 python manage.py test', 'manage.py'],
    ['npx --no-install tsx scripts/check.ts', 'scripts/check.ts'],
    ['python3.12 manage.py test', 'manage.py'],
    ['pnpm node scripts/check.js', 'scripts/check.js'],
    ['node --test test/new.test.js', 'test/new.test.js'],
    ['node --check --build-snapshot scripts/check.js', 'scripts/check.js'],
    ['groovy -cp lib test/check.groovy', 'test/check.groovy'],
    ['elixir -pa ebin test/x.exs', 'test/x.exs'],
    ['bun scripts/check.ts', 'scripts/check.ts'],
    ['bun run scripts/check.ts', 'scripts/check.ts'],
    ['deno run -A scripts/check.ts', 'scripts/check.ts'],
    ['composer exec php scripts/check.php', 'scripts/check.php'],
    ['uv run python scripts/check.py', 'scripts/check.py'],
    ['uv run --python 3.12 python scripts/check.py', 'scripts/check.py'],
    ['uv run -qp 3.12 python scripts/check.py', 'scripts/check.py'],
  ])('names the script file %s runs: %s', (command, file) => {
    expect(checkDefinition(command)).toEqual({ kind: 'script-file', file });
  });

  it.each([
    ['pnpm --filter x test', 'pnpm', 'test', '.'],
    ['pnpm --filter=x test', 'pnpm', 'test', '.'],
    ['pnpm -F x run test', 'pnpm', 'test', '.'],
    ['pnpm -C packages/x test', 'pnpm', 'test', 'packages/x'],
    ['pnpm --dir packages/x test', 'pnpm', 'test', 'packages/x'],
    ['pnpm --dir=./packages/x/ test', 'pnpm', 'test', 'packages/x'],
    ['pnpm -r test', 'pnpm', 'test', '.'],
    ['pnpm -F x run lint', 'pnpm', 'lint', '.'],
    ['pnpm lint', 'pnpm', 'lint', '.'],
    ['pnpm run test', 'pnpm', 'test', '.'],
    ['pnpm test', 'pnpm', 'test', '.'],
    ['pnpm t', 'pnpm', 'test', '.'],
    ['pnpm run toString', 'pnpm', 'toString', '.'],
    ['yarn constructor', 'yarn', 'constructor', '.'],
    ['npm test', 'npm', 'test', '.'],
    ['npm -w pkg run test', 'npm', 'test', '.'],
    ['npm --workspace=pkg run test', 'npm', 'test', '.'],
    ['npm test -w pkg', 'npm', 'test', '.'],
    ['npm run test --workspaces', 'npm', 'test', '.'],
    ['npm --prefix sub test', 'npm', 'test', 'sub'],
    ['npm --prefix=test/fixtures/app test', 'npm', 'test', 'test/fixtures/app'],
    ['npm -C sub test', 'npm', 'test', 'sub'],
    ['npm -Csub test', 'npm', 'test', 'sub'],
    ['npm --prefix . test', 'npm', 'test', '.'],
    ['npm run test -- --prefix sub', 'npm', 'test', '.'],
    ['mise exec -- npm -w pkg run test', 'npm', 'test', '.'],
    ['mise exec -- npm --prefix sub run test', 'npm', 'test', 'sub'],
    ['npm run test -- --coverage', 'npm', 'test', '.'],
    ['yarn workspace x test', 'yarn', 'test', '.'],
    ['yarn workspaces foreach -A run test', 'yarn', 'test', '.'],
    ['yarn workspaces foreach --from x run test', 'yarn', 'test', '.'],
    ['yarn workspaces foreach --include x --exclude y -j 2 run test', 'yarn', 'test', '.'],
    ['yarn workspaces foreach --jobs 2 run test', 'yarn', 'test', '.'],
    ['yarn --cwd dist test', 'yarn', 'test', 'dist'],
    ['yarn --cwd=dist test', 'yarn', 'test', 'dist'],
    ['bun run test', 'bun', 'test', '.'],
    ['bun run --filter x test', 'bun', 'test', '.'],
    ['bun --cwd web run test', 'bun', 'test', 'web'],
    ['bun run build', 'bun', 'build', '.'],
    ['npm start', 'npm', 'start', '.'],
    ['npm restart', 'npm', 'restart', '.'],
    ['pnpm stop', 'pnpm', 'stop', '.'],
    ['yarn start', 'yarn', 'start', '.'],
    ['bun start', 'bun', 'start', '.'],
  ])('names the package script %s runs: %s %s in %s', (command, runner, script, dir) => {
    expect(checkDefinition(command)).toEqual({
      kind: 'package-script',
      runner,
      manifest: 'package.json',
      script,
      dir,
    });
  });

  it.each([
    ['composer test', '.'],
    ['composer run-script test', '.'],
    ['composer -d sub test', 'sub'],
    ['composer --working-dir=sub test', 'sub'],
    ['composer --working-dir sub test', 'sub'],
    ['composer -d vendor/acme/x test', 'vendor/acme/x'],
  ])('names the composer script %s runs, in %s', (command, dir) => {
    expect(checkDefinition(command)).toEqual({
      kind: 'package-script',
      runner: 'composer',
      manifest: 'composer.json',
      script: 'test',
      dir,
    });
  });

  it.each([
    ['uv run make test', MAKE],
    ['uv run --package make python scripts/check.py', MAKE],
    ['make check', MAKE],
    ['pnpm exec just test', JUST],
    ['bundle exec rake test', RAKE],
    ['rake spec', RAKE],
    ['composer exec make test', MAKE],
    [
      './gradlew test',
      { kind: 'wrapper', runner: './gradlew', files: ['gradlew'], dirs: ['gradle/wrapper'] },
    ],
    [
      'mise exec -- ./mvnw verify',
      { kind: 'wrapper', runner: './mvnw', files: ['mvnw'], dirs: ['.mvn/wrapper'] },
    ],
  ])('names the task file or build wrapper %s runs', (command, definition) => {
    expect(checkDefinition(command)).toEqual(definition);
  });

  it.each([
    'python -m pytest',
    'node --version',
    'bun test',
    'bun build ./src/index.ts',
    'deno test',
    'pnpm exec vitest',
    'npm exec --no-install vitest',
    'deno task test',
    'mix test',
    'turbo run test',
    'gradlew test',
    'sub/gradlew test',
    'composer exec phpunit',
    'constructor x',
  ])('names no definition for %s', (command) => {
    expect(checkDefinition(command)).toBeNull();
  });
});
