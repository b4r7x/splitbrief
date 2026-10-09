import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { runBaseOf } from '../isolation/base-tree.js';
import { changedDefinitionRefusal } from './changed-script.js';

const PACKAGE = JSON.stringify({ scripts: { test: 'vitest run', lint: 'biome check' } });

function refusal(run: ApplyRun, command: string): Promise<string | null> {
  const base = runBaseOf({ projectDir: run.dir, sessionId: run.sessionId }, run);
  if (base === undefined) throw new Error('The run recorded no workspace base');
  return changedDefinitionRefusal({ command, base, workspaceDir: run.ws });
}

function writePackage(run: ApplyRun, scripts: Record<string, string>): void {
  writeFileSync(join(run.ws, 'package.json'), JSON.stringify({ scripts }));
}

function write(dir: string, file: string, content: string | Buffer): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

const MONOREPO = {
  'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'vitest run' } }),
  'packages/x/package.json': JSON.stringify({
    name: 'x',
    scripts: { test: 'vitest run', lint: 'biome check' },
    dependencies: { zod: '4.0.0' },
  }),
  'packages/y/package.json': JSON.stringify({ name: 'y', scripts: { test: 'vitest run' } }),
  'test/fixtures/app/package.json': JSON.stringify({ scripts: { test: 'node app.js' } }),
};

function writeX(run: ApplyRun, scripts: Record<string, string>, dependencies = { zod: '4.0.0' }) {
  write(run.ws, 'packages/x/package.json', JSON.stringify({ name: 'x', scripts, dependencies }));
}

const COMPOSER = {
  require: { php: '^8.2' },
  scripts: { check: ['@lint', '@test'], test: ['phpunit'], lint: 'phpcs' },
};

function writeComposer(run: ApplyRun, composer: Record<string, unknown>): void {
  write(run.ws, 'composer.json', JSON.stringify({ ...COMPOSER, ...composer }));
}

const GRADLE = {
  gradlew: '#!/bin/sh\nexec java -jar gradle/wrapper/gradle-wrapper.jar "$@"\n',
  'gradle/wrapper/gradle-wrapper.jar': 'PK\u0003\u0004wrapper',
  'gradle/wrapper/gradle-wrapper.properties':
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n',
  'build.gradle': "plugins { id 'java' }\n",
};

const MAVEN = {
  mvnw: '#!/bin/sh\nexec java -cp .mvn/wrapper "$@"\n',
  '.mvn/wrapper/maven-wrapper.properties':
    'distributionUrl=https://repo.maven.apache.org/maven2/maven-3.9.9-bin.zip\n',
  'pom.xml': '<project></project>\n',
};

describe('changedDefinitionRefusal', { timeout: 60_000 }, () => {
  it('admits a package script when package.json is the one the run started from', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-same' },
      async (run) => {
        expect(await refusal(run, 'npm test')).toBeNull();
      },
    );
  });

  it('refuses a package script whose text this run changed', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-text' },
      async (run) => {
        writePackage(run, { test: 'echo ok', lint: 'biome check' });

        expect(await refusal(run, 'npm test')).toBe(
          'runs the package script test, which this run changed',
        );
        expect(await refusal(run, 'pnpm run test')).toBe(
          'runs the package script test, which this run changed',
        );
      },
    );
  });

  it('admits a package script when the run changed only another script', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-other' },
      async (run) => {
        writePackage(run, { test: 'vitest run', lint: 'echo ok' });

        expect(await refusal(run, 'npm test')).toBeNull();
        expect(await refusal(run, 'yarn lint')).toBe(
          'runs the package script lint, which this run changed',
        );
      },
    );
  });

  it('admits bun test, which runs bun’s own test runner and no package script', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-bun' },
      async (run) => {
        writePackage(run, { test: 'echo ok', lint: 'biome check' });

        expect(await refusal(run, 'bun test')).toBeNull();
        expect(await refusal(run, 'bun run test')).toBe(
          'runs the package script test, which this run changed',
        );
      },
    );
  });

  it('refuses make when the run changed the Makefile', async () => {
    await withApplyRun(
      { Makefile: 'test:\n\tpytest\n' },
      { sessionId: 'sess-make-changed' },
      async (run) => {
        expect(await refusal(run, 'make test')).toBeNull();
        writeFileSync(join(run.ws, 'Makefile'), 'test:\n\ttrue\n');

        expect(await refusal(run, 'make test')).toBe(
          'runs make on Makefile, which this run changed',
        );
      },
    );
  });

  it('refuses make when the run created the Makefile', async () => {
    await withApplyRun({ 'src/a.py': 'a = 1\n' }, { sessionId: 'sess-make-new' }, async (run) => {
      expect(await refusal(run, 'make test')).toBeNull();
      writeFileSync(join(run.ws, 'Makefile'), 'test:\n\ttrue\n');

      expect(await refusal(run, 'make test')).toBe(
        'runs make on Makefile, which the run base does not hold',
      );
    });
  });

  it('admits a command that runs no script or task file', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-none' },
      async (run) => {
        writePackage(run, { test: 'echo ok' });

        expect(await refusal(run, 'npx --no-install vitest run')).toBeNull();
        expect(await refusal(run, 'pytest')).toBeNull();
      },
    );
  });
  it('refuses a package.json test script for every runner when the run changed its pretest or posttest script', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-pre-post' },
      async (run) => {
        writePackage(run, { pretest: 'echo setup', test: 'vitest run', lint: 'biome check' });
        for (const command of ['npm test', 'pnpm test', 'yarn test', 'bun run test']) {
          expect(await refusal(run, command)).toBe(
            'runs the package script test with its pretest script, which this run changed',
          );
        }
        expect(await refusal(run, 'pnpm lint')).toBeNull();

        writePackage(run, { test: 'vitest run', posttest: 'echo done', lint: 'biome check' });
        for (const command of ['npm run test', 'yarn run test', 'pnpm run test']) {
          expect(await refusal(run, command)).toBe(
            'runs the package script test with its posttest script, which this run changed',
          );
        }
      },
    );
  });

  it('refuses a package script when the run left package.json unreadable', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-malformed' },
      async (run) => {
        writeFileSync(join(run.ws, 'package.json'), '{ "scripts": ');

        expect(await refusal(run, 'npm test')).toBe(
          'runs the package script test, and this run changed package.json',
        );
      },
    );
  });

  it('refuses just when the run changed the Justfile', async () => {
    await withApplyRun(
      { Justfile: 'test:\n\tcargo test\n' },
      { sessionId: 'sess-just-changed' },
      async (run) => {
        expect(await refusal(run, 'just test')).toBeNull();
        writeFileSync(join(run.ws, 'Justfile'), 'test:\n\ttrue\n');

        expect(await refusal(run, 'just test')).toBe(
          'runs just on Justfile, which this run changed',
        );
      },
    );
  });

  it('refuses an interpreter script this run changed or created, through a forwarder too', async () => {
    await withApplyRun(
      { 'manage.py': 'print("test")\n', artisan: '<?php\n' },
      { sessionId: 'sess-script-interpreter' },
      async (run) => {
        expect(await refusal(run, 'python manage.py test')).toBeNull();
        writeFileSync(join(run.ws, 'manage.py'), 'print("ok")\n');
        writeFileSync(join(run.ws, 'check.js'), 'process.exit(0)\n');

        expect(await refusal(run, 'python manage.py test')).toBe(
          'runs manage.py, which this run changed',
        );
        expect(await refusal(run, 'uv run python ./manage.py test')).toBe(
          'runs manage.py, which this run changed',
        );
        expect(await refusal(run, 'node check.js')).toBe(
          'runs check.js, which the run base does not hold',
        );
        expect(await refusal(run, 'php artisan test')).toBeNull();
        expect(await refusal(run, 'python -m pytest')).toBeNull();
      },
    );
  });

  it('admits a test file this run created or changed: it is a test, not a check definition', async () => {
    await withApplyRun(
      { 'test/old_test.rb': 'puts 1\n', 'lib/a.rb': 'A = 1\n' },
      { sessionId: 'sess-script-test-file' },
      async (run) => {
        writeFileSync(join(run.ws, 'test/old_test.rb'), 'puts 2\n');
        writeFileSync(join(run.ws, 'test/new_test.rb'), 'puts 3\n');
        writeFileSync(join(run.ws, 'test/new.test.js'), 'process.exit(0)\n');
        writeFileSync(join(run.ws, 'lib/check.rb'), 'exit 0\n');

        expect(await refusal(run, 'ruby -Ilib test/new_test.rb')).toBeNull();
        expect(await refusal(run, 'ruby -Ilib test/old_test.rb')).toBeNull();
        expect(await refusal(run, 'node --test test/new.test.js')).toBeNull();
        expect(await refusal(run, 'ruby lib/check.rb')).toBe(
          'runs lib/check.rb, which the run base does not hold',
        );
      },
    );
  });

  it('refuses a bun or deno script file this run created', async () => {
    await withApplyRun(
      { 'src/a.ts': 'export {};\n' },
      { sessionId: 'sess-script-bun-deno' },
      async (run) => {
        writeFileSync(join(run.ws, 'check.ts'), 'Deno.exit(0);\n');

        expect(await refusal(run, 'bun check.ts')).toBe(
          'runs check.ts, which the run base does not hold',
        );
        expect(await refusal(run, 'bun run check.ts')).toBe(
          'runs check.ts, which the run base does not hold',
        );
        expect(await refusal(run, 'deno run -A check.ts')).toBe(
          'runs check.ts, which the run base does not hold',
        );
        expect(await refusal(run, 'deno test')).toBeNull();
      },
    );
  });

  it('compares with the package.json the run base itself holds, not the checkout baseline', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      {
        sessionId: 'sess-script-base-blob',
        atBase: (dir) =>
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts: { test: 'vitest run --reporter dot', lint: 'biome check' } }),
          ),
      },
      async (run) => {
        writePackage(run, { test: 'vitest run --reporter dot', lint: 'echo ok' });

        expect(await refusal(run, 'npm test')).toBeNull();
        expect(await refusal(run, 'npm run lint')).toBe(
          'runs the package script lint, which this run changed',
        );
      },
    );
  });

  it('refuses a workspace package script the run changed, naming its package.json', async () => {
    await withApplyRun(MONOREPO, { sessionId: 'sess-mono-changed' }, async (run) => {
      expect(await refusal(run, 'pnpm --filter x test')).toBeNull();
      writeX(run, { test: 'echo ok', lint: 'biome check' });

      const named =
        'runs the package script test, which this run changed in packages/x/package.json';
      expect(await refusal(run, 'pnpm --filter x test')).toBe(named);
      expect(await refusal(run, 'npm -w packages/x run test')).toBe(named);
      expect(await refusal(run, 'yarn workspace x test')).toBe(named);
      expect(await refusal(run, 'pnpm -r test')).toBe(named);
      expect(await refusal(run, 'npm test')).toBe(named);
      expect(await refusal(run, 'pnpm --filter x run lint')).toBeNull();
    });
  });

  it('admits a workspace package script when the run changed only its dependencies', async () => {
    await withApplyRun(MONOREPO, { sessionId: 'sess-mono-deps' }, async (run) => {
      writeX(run, { test: 'vitest run', lint: 'biome check' }, { zod: '4.1.0' });

      expect(await refusal(run, 'pnpm --filter x test')).toBeNull();
    });
  });

  it('refuses a recursive package script when the run created a package', async () => {
    await withApplyRun(MONOREPO, { sessionId: 'sess-mono-new' }, async (run) => {
      write(
        run.ws,
        'packages/z/package.json',
        JSON.stringify({ name: 'z', scripts: { test: 'echo ok' } }),
      );

      expect(await refusal(run, 'pnpm -r test')).toBe(
        'runs the package script test, and the run base does not hold packages/z/package.json',
      );
    });
  });

  it('admits a package script when the run changed only a test fixture package.json', async () => {
    await withApplyRun(MONOREPO, { sessionId: 'sess-mono-fixture' }, async (run) => {
      write(
        run.ws,
        'test/fixtures/app/package.json',
        JSON.stringify({ scripts: { test: 'echo ok' } }),
      );

      expect(await refusal(run, 'npm test')).toBeNull();
    });
  });

  it('compares the manifest a directory option names, a fixture or a gitignored one too', async () => {
    await withApplyRun(
      { '.gitignore': 'dist/\n', 'package.json': PACKAGE },
      { sessionId: 'sess-script-dir-new' },
      async (run) => {
        const fixture = JSON.stringify({ scripts: { test: 'node app.js' } });
        write(run.ws, 'test/fixtures/app/package.json', fixture);
        write(run.ws, 'dist/package.json', fixture);

        expect(await refusal(run, 'npm test')).toBeNull();
        expect(await refusal(run, 'npm --prefix test/fixtures/app test')).toBe(
          'runs the package script test, and the run base does not hold test/fixtures/app/package.json',
        );
        expect(await refusal(run, 'yarn --cwd=dist test')).toBe(
          'runs the package script test, and the run base does not hold dist/package.json',
        );
      },
    );
    await withApplyRun(MONOREPO, { sessionId: 'sess-script-dir-changed' }, async (run) => {
      expect(await refusal(run, 'pnpm -C packages/x test')).toBeNull();
      expect(await refusal(run, 'npm --prefix test/fixtures/app test')).toBeNull();

      write(
        run.ws,
        'test/fixtures/app/package.json',
        JSON.stringify({ scripts: { test: 'echo ok' } }),
      );
      expect(await refusal(run, 'pnpm -C packages/x test')).toBeNull();
      expect(await refusal(run, 'npm --prefix test/fixtures/app test')).toBe(
        'runs the package script test, which this run changed in test/fixtures/app/package.json',
      );
    });
  });

  it('refuses a workspace package script whose pretest script the run changed', async () => {
    await withApplyRun(MONOREPO, { sessionId: 'sess-mono-pretest' }, async (run) => {
      writeX(run, { pretest: 'echo setup', test: 'vitest run', lint: 'biome check' });

      expect(await refusal(run, 'npm -w packages/x test')).toBe(
        'runs the package script test with its pretest script, which this run changed in packages/x/package.json',
      );
    });
  });

  it('compares the composer scripts a script reaches through @ references', async () => {
    await withApplyRun(
      { 'composer.json': JSON.stringify(COMPOSER) },
      { sessionId: 'sess-composer' },
      async (run) => {
        writeComposer(run, { require: { php: '^8.3' } });
        expect(await refusal(run, 'composer test')).toBeNull();
        expect(await refusal(run, 'composer check')).toBeNull();

        writeComposer(run, { scripts: { ...COMPOSER.scripts, lint: 'true' } });
        expect(await refusal(run, 'composer check')).toBe(
          'runs the package script check with its lint script, which this run changed',
        );
        expect(await refusal(run, 'composer test')).toBeNull();

        writeComposer(run, { 'scripts-aliases': { test: ['t'] } });
        expect(await refusal(run, 'composer test')).toBe(
          'runs the package script test, and this run changed scripts-aliases in composer.json',
        );
      },
    );
  });

  it('refuses rake when the run changed the Rakefile or added a rakelib task', async () => {
    await withApplyRun(
      { Rakefile: 'task :test do\n  ruby "test/all.rb"\nend\n' },
      { sessionId: 'sess-rake' },
      async (run) => {
        expect(await refusal(run, 'rake test')).toBeNull();
        expect(await refusal(run, 'bundle exec rake test')).toBeNull();

        write(run.ws, 'rakelib/ci.rake', 'task :test do\n  sh "true"\nend\n');
        expect(await refusal(run, 'rake test')).toBe(
          'runs rake on rakelib/ci.rake, which the run base does not hold',
        );

        write(run.ws, 'Rakefile', 'task :test do\n  sh "true"\nend\n');
        expect(await refusal(run, 'rake test')).toBe(
          'runs rake on Rakefile, which this run changed',
        );
        expect(await refusal(run, 'bundle exec rake test')).toBe(
          'runs rake on Rakefile, which this run changed',
        );
      },
    );
  });

  it('refuses make through uv run when the run changed the Makefile', async () => {
    await withApplyRun(
      { Makefile: 'test:\n\tpytest\n' },
      { sessionId: 'sess-uv-make' },
      async (run) => {
        expect(await refusal(run, 'uv run make test')).toBeNull();
        write(run.ws, 'Makefile', 'test:\n\ttrue\n');

        expect(await refusal(run, 'uv run make test')).toBe(
          'runs make on Makefile, which this run changed',
        );
      },
    );
  });

  it('admits a gradle wrapper the run left alone, and refuses one it changed', async () => {
    await withApplyRun(GRADLE, { sessionId: 'sess-gradle' }, async (run) => {
      expect(await refusal(run, './gradlew test')).toBeNull();
      write(run.ws, 'build.gradle', "plugins { id 'application' }\n");
      expect(await refusal(run, './gradlew test')).toBeNull();

      write(
        run.ws,
        'gradle/wrapper/gradle-wrapper.properties',
        'distributionUrl=https\\://example.test/gradle.zip\n',
      );
      expect(await refusal(run, './gradlew test')).toBe(
        'runs ./gradlew on gradle/wrapper/gradle-wrapper.properties, which this run changed',
      );
    });
  });

  it('refuses a gradle wrapper whose script or jar bytes the run changed', async () => {
    await withApplyRun(GRADLE, { sessionId: 'sess-gradle-jar' }, async (run) => {
      write(run.ws, 'gradle/wrapper/gradle-wrapper.jar', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
      expect(await refusal(run, './gradlew test')).toBe(
        'runs ./gradlew on gradle/wrapper/gradle-wrapper.jar, which this run changed',
      );

      write(run.ws, 'gradlew', '#!/bin/sh\nexit 0\n');
      expect(await refusal(run, './gradlew test')).toBe(
        'runs ./gradlew on gradlew, which this run changed',
      );
    });
  });

  it('compares a symbolic link in the wrapper directory by the file it names', async () => {
    await withApplyRun(GRADLE, { sessionId: 'sess-gradle-link' }, async (run) => {
      write(run.ws, 'build/own.jar', 'PK\u0003\u0004own');
      rmSync(join(run.ws, 'gradle/wrapper/gradle-wrapper.jar'));
      symlinkSync(join(run.ws, 'build/own.jar'), join(run.ws, 'gradle/wrapper/gradle-wrapper.jar'));

      expect(await refusal(run, './gradlew test')).toBe(
        'runs ./gradlew on gradle/wrapper/gradle-wrapper.jar, which this run changed',
      );
    });
  });

  it('refuses a wrapper or rakelib directory that is a symbolic link', async () => {
    await withApplyRun(
      { ...GRADLE, Rakefile: 'task :test do\nend\n' },
      { sessionId: 'sess-gradle-dir-link' },
      async (run) => {
        cpSync(join(run.ws, 'gradle/wrapper'), join(run.ws, 'build/wrapper'), { recursive: true });
        rmSync(join(run.ws, 'gradle/wrapper'), { recursive: true });
        symlinkSync(join(run.ws, 'build/wrapper'), join(run.ws, 'gradle/wrapper'));
        symlinkSync(join(run.ws, 'build'), join(run.ws, 'rakelib'));

        expect(await refusal(run, './gradlew test')).toBe(
          'runs ./gradlew on gradle/wrapper, which is a symbolic link',
        );
        expect(await refusal(run, 'rake test')).toBe(
          'runs rake on rakelib, which is a symbolic link',
        );
      },
    );
  });

  it('refuses a maven wrapper when the run added a file the run base does not hold', async () => {
    await withApplyRun(MAVEN, { sessionId: 'sess-maven' }, async (run) => {
      expect(await refusal(run, './mvnw verify')).toBeNull();
      write(run.ws, 'pom.xml', '<project><modules/></project>\n');
      expect(await refusal(run, './mvnw verify')).toBeNull();

      write(run.ws, '.mvn/wrapper/MavenWrapperDownloader.class', 'cafebabe');
      expect(await refusal(run, './mvnw verify')).toBe(
        'runs ./mvnw on .mvn/wrapper/MavenWrapperDownloader.class, which the run base does not hold',
      );
    });
    await withApplyRun(MAVEN, { sessionId: 'sess-maven-jar' }, async (run) => {
      write(run.ws, '.mvn/wrapper/maven-wrapper.jar', 'PK\u0003\u0004');
      expect(await refusal(run, './mvnw verify')).toBe(
        'runs ./mvnw on .mvn/wrapper/maven-wrapper.jar, which the run base does not hold',
      );
    });
  });

  it('refuses a wrapper the run created in a project that had none', async () => {
    await withApplyRun(
      { 'src/A.java': 'class A {}\n' },
      { sessionId: 'sess-gradle-new' },
      async (run) => {
        expect(await refusal(run, './gradlew test')).toBeNull();
        for (const [file, content] of Object.entries(GRADLE)) write(run.ws, file, content);

        expect(await refusal(run, './gradlew test')).toBe(
          'runs ./gradlew on gradlew, which the run base does not hold',
        );
      },
    );
  });

  it('refuses only a wrapper when the run has no run base', async () => {
    await withApplyRun(GRADLE, { sessionId: 'sess-no-base' }, async (run) => {
      const noBase = (command: string) =>
        changedDefinitionRefusal({ command, base: undefined, workspaceDir: run.ws });

      expect(await noBase('./gradlew test')).toBe(
        'runs ./gradlew, and this run has no run base to compare its wrapper files with',
      );
      expect(await noBase('npm test')).toBeNull();
    });
  });

  it('refuses a gitignored interpreter script in a checkout, which the run base does not hold', async () => {
    await withApplyRun(
      { '.gitignore': 'vendor/\n', 'composer.json': JSON.stringify(COMPOSER) },
      {
        sessionId: 'sess-checkout-vendor',
        atBase: (dir) => write(dir, 'vendor/bin/phpunit', '<?php\n'),
      },
      async (run) => {
        const base = runBaseOf({ projectDir: run.dir, sessionId: run.sessionId }, run);
        const inCheckout = (command: string) =>
          changedDefinitionRefusal({ command, base, workspaceDir: run.dir });

        expect(await inCheckout('php vendor/bin/phpunit')).toBe(
          'runs vendor/bin/phpunit, which the run base does not hold',
        );
        expect(await inCheckout('composer test')).toBeNull();
        expect(await inCheckout('composer exec phpunit')).toBeNull();
      },
    );
  });

  it('reads composer exec as a program, never as a script named exec', async () => {
    await withApplyRun(
      { 'composer.json': JSON.stringify(COMPOSER), Makefile: 'test:\n\tphpunit\n' },
      { sessionId: 'sess-composer-exec' },
      async (run) => {
        writeComposer(run, { scripts: { ...COMPOSER.scripts, exec: 'true' } });
        expect(await refusal(run, 'composer exec phpunit')).toBeNull();
        expect(await refusal(run, 'composer run-script exec')).toBe(
          'runs the package script exec, which this run changed',
        );

        write(run.ws, 'Makefile', 'test:\n\ttrue\n');
        expect(await refusal(run, 'composer exec make test')).toBe(
          'runs make on Makefile, which this run changed',
        );
      },
    );
  });
});
