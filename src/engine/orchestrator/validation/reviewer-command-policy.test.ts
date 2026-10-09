import { describe, expect, it } from 'vitest';
import {
  interpreterScript,
  REVIEWER_COMMAND_RULES,
  reviewerCommandRefusal,
} from './reviewer-command-policy.js';

describe('reviewerCommandRefusal', () => {
  it.each([
    'mvn test',
    'gradle test',
    'composer test',
    'bundle exec rspec',
    'make check',
    'just test',
    'dotnet test',
    'mix test',
    'cargo test',
    'go test ./...',
    'npm test',
    'npm run lint',
    'npm run deploy',
    'npm test x',
    'npm run x',
    'npm run test:unit x',
    'npm --prefix x test',
    'npm -C x test',
    'npm -w x test',
    'npm --workspace x test',
    'npm --prefix=x test',
    'npm -Cx test',
    'npm test exec',
    'npm run explore',
    'npm test -- exec',
    'pnpm test',
    'yarn test',
    'python -m pytest -x',
    'python manage.py test',
    'php artisan test',
    'rake test',
    'uv run pytest',
    'conda run -n py312 pytest',
    'uv run --group test pytest',
    'uv run --frozen pytest',
    'uv run --all-extras pytest',
    'pixi run -e test pytest',
    'poetry run --verbose pytest',
    'pipenv run --verbose pytest',
    'pdm run -v pytest',
    'hatch run --verbose test:pytest',
    'bundle exec --keep-file-descriptors rspec',
    'npx --no-install vitest run src/a.test.ts',
    'npx --no-install tsc -p tsconfig.json',
    'npm exec --no-install vitest run',
    'node --version',
    'deno test',
    'ruby -Ilib -Itest test/a_test.rb',
    'python -Werror -m pytest',
    'npm test -- -t x',
    'mvn -q test',
    'mvn -f other/pom.xml test',
    'mvn -fother.xml test',
    'mvn --file=other.xml test',
    'mvn -f module/pom.xml verify',
    'mvn -fae -Dtest=FooTest test',
    'gradle :app:test',
    'gradle -b other.gradle test',
    'gradle --build-file other.gradle test',
    'gradle -c other.gradle test',
    'gradle -p sub test',
    'gradle --project-dir sub test',
    'gradle -g cache test',
    'gradle --gradle-user-home cache test',
    'gradle test -Porg.gradle.caching=true',
    'pnpm --filter web test',
    'pnpm vitest run',
    'pnpm lint',
    'yarn workspace web test',
    'node --test test/new.test.js',
    'ruby -Ilib test/new_test.rb',
    'python3.12 -m pytest',
    'make check DESTDIR=build',
    'make -k check',
    'rake -T',
    'rake -f other.rake test',
    'rake --rakefile other.rake test',
    'rake -C sub test',
    'rake -R tasks test',
    'rake --rakelibdir tasks test',
    'rake --rakelib tasks test',
    'rake -g test',
    'rake --system test',
    'just --list',
    'npx --no-install --no-yes vitest',
    'mise exec -- npm test',
    'hatch run test:pytest',
    'bun test',
    'bun run test',
    'deno run -A main.ts',
    'gcc -Ilib -o build/a a.c',
  ])('runs %s', (command) => {
    expect(reviewerCommandRefusal(command)).toBeNull();
  });

  it.each([
    ['', 'names no program'],
    ['npm test && rm -rf src', 'contains a shell operator'],
    ['npm test > out.txt', 'contains a shell operator'],
    ['pytest $(cat list)', 'contains a shell operator'],
    ['CI=1 npm test', 'sets an environment variable before the program'],
    ['./mvnw test', 'runs a program by path'],
    ['./gradlew test', 'runs a program by path'],
    ['bin/test', 'runs a program by path'],
    ['cd src', 'changes the directory'],
    ['bash -c "npm test"', 'runs the shell bash'],
    ['sh test.sh', 'runs the shell sh'],
    ['env npm test', 'runs another command line through env'],
    ['sudo npm test', 'runs another command line through sudo'],
    ['xargs pytest', 'runs another command line through xargs'],
    ['timeout 60 npm test', 'runs another command line through timeout'],
    ['git status', 'runs git, which does not verify a change'],
    ['rm -rf dist', 'runs rm, which does not verify a change'],
    ['docker compose up', 'runs docker, which does not verify a change'],
    ['curl https://example.test', 'names a URL or a remote package'],
    ['deno run npm:cowsay', 'names a URL or a remote package'],
    ['pytest /etc', 'names a path outside the run workspace'],
    ['npm --prefix=../other test', 'names a path outside the run workspace'],
    ['node -e 1', 'runs inline code'],
    ['python -c "import os"', 'runs inline code'],
    ['python3 -Ic "import os"', 'runs inline code'],
    ['python -W ignore -c "import os"', 'runs inline code'],
    ['ruby -e "puts 1"', 'runs inline code'],
    ['php -r "echo 1;"', 'contains a shell operator'],
    ['php -r "echo 1"', 'runs inline code'],
    ['perl -E "say 1"', 'runs inline code'],
    ['deno eval "console.log"', 'runs inline code'],
    ['node --import ./x.mjs test.js', 'runs inline code'],
    ['npx vitest run', 'runs npx without --no-install'],
    ['npx --yes --no-install vitest', 'runs npx without --no-install'],
    ['npx --no-install -p cowsay cowsay', 'runs code through npx'],
    ['npx --no-install', 'runs npx without a program'],
    ['npx --no-install ./scripts/check.js', 'runs a program by path'],
    ['npx --no-install rm -rf src', 'runs rm, which does not verify a change'],
    ['npx --no-install tsx -e "1"', 'runs inline code'],
    ['npm exec vitest', 'runs npm exec without --no-install'],
    ['npm x -- vitest', 'runs npm exec without --no-install'],
    ['bunx vitest', 'downloads and runs a package (bunx)'],
    ['uvx ruff check', 'downloads and runs a package (uvx)'],
    ['pipx run ruff', 'downloads and runs a package (pipx run)'],
    ['pnpm dlx vitest', 'downloads and runs a package (pnpm dlx)'],
    ['yarn dlx vitest', 'downloads and runs a package (yarn dlx)'],
    ['bun x vitest', 'downloads and runs a package (bun x)'],
    ['uv tool run ruff', 'downloads and runs a package (uv tool run)'],
    [
      'go run golang.org/x/tools/cmd/stringer@latest',
      'downloads and runs a package (go run <package>@<version>)',
    ],
    ['npm install', 'runs a setup command (npm install)'],
    ['npm ci', 'runs a setup command (npm ci)'],
    ['npm i', 'runs a setup command (npm i)'],
    ['pip install -r requirements.txt', 'runs a setup command (pip install)'],
    ['python -m pip install pytest', 'runs a setup command (pip install)'],
    ['uv pip install pytest', 'runs a setup command (uv pip install)'],
    ['uv sync', 'runs a setup command (uv sync)'],
    ['go generate ./...', 'runs a setup command (go generate)'],
    ['go get example.test/x', 'runs a setup command (go get)'],
    ['go mod download', 'runs a setup command (go mod download)'],
    ['go mod tidy', 'runs a setup command (go mod tidy)'],
    ['bundle install', 'runs a setup command (bundle install)'],
    ['composer install', 'runs a setup command (composer install)'],
    ['cargo install ripgrep', 'runs a setup command (cargo install)'],
    ['mvn clean install', 'runs a setup command (mvn install)'],
    ['mvn deploy', 'runs a setup command (mvn deploy)'],
    ['gradle publish', 'runs a setup command (gradle publish)'],
    ['mix deps.get', 'runs a setup command (mix deps.get)'],
    ['dotnet tool install dotnet-ef', 'runs a setup command (dotnet tool install)'],
    ['dotnet restore', 'runs a setup command (dotnet restore)'],
    ['yarn global add x', 'runs a setup command (yarn global add)'],
    ['bundle exec rake install', 'runs a setup command (rake install)'],
    ['yarn', 'runs yarn with no argument, which installs'],
    ['yarn --frozen-lockfile', 'runs yarn with no argument, which installs'],
    ['bundle', 'runs bundle with no argument, which installs'],
    ['composer', 'runs composer with no argument, which installs'],
    ['make -C sub test', 'runs make in another directory or on another file'],
    ['make -f other.mk test', 'runs make in another directory or on another file'],
    ['make --file=other.mk test', 'runs make in another directory or on another file'],
    ['just --justfile other test', 'runs just in another directory or on another file'],
    ['just --working-directory sub test', 'runs just in another directory or on another file'],
    ['uv run python -c "import os"', 'runs inline code'],
    ['conda run -n myenv python -c x', 'runs inline code'],
    ['conda run -n env pytest', 'runs another command line through env'],
    ['uv run --group dev python -c x', 'runs inline code'],
    ['hatch run --verbose test:python -c x', 'runs inline code'],
    ['uv run --with requests pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run --with=requests pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run --with-editable local pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run --with-editable=local pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run --with-requirements req.txt pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run --with-requirements=req.txt pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run -w requests pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run -wrequests pytest', 'downloads and runs a package (uv run --with)'],
    ['uv run --directory /tmp pytest', 'names a path outside the run workspace'],
    ['poetry run git status', 'runs git, which does not verify a change'],
    ["make '--eval=pwn:\n\ttouch pwned' pwn", 'contains a control character'],
    ['npm test "a\u0007b"', 'contains a control character'],
    ['make --eval=pwn:x pwn', 'runs inline code'],
    ['make --ev=pwn:x pwn', 'runs inline code'],
    ['make -E x', 'runs inline code'],
    ['make -kEx', 'runs inline code'],
    ['make SHELL=node .SHELLFLAGS=-e check', 'sets the make variable SHELL'],
    ['make .SHELLFLAGS=-ec check', 'sets the make variable .SHELLFLAGS'],
    ['make MAKEFILES=evil.mk check', 'sets the make variable MAKEFILES'],
    ['make MAKEFLAGS=--eval=x check', 'sets the make variable MAKEFLAGS'],
    ["make 'SHELL := node' check", 'sets the make variable SHELL'],
    ["make 'X!=touch pwned' check", 'runs inline code'],
    ["rake -e 'exec x'", 'runs inline code'],
    ['rake --execute-print x', 'runs inline code'],
    ['rake -p x', 'runs inline code'],
    ['just -c x', 'runs inline code'],
    ['just --command x', 'runs inline code'],
    ['just --shell node test', 'runs inline code'],
    ['just --shell-arg -e test', 'runs inline code'],
    ['python3.12 -c x', 'runs inline code'],
    ['pypy3 -c x', 'runs inline code'],
    ['node22 -e x', 'runs inline code'],
    ['pypy3 -m pip install x', 'runs a setup command (pip install)'],
    ['yarn node -e x', 'runs inline code'],
    ['pnpm node -e x', 'runs inline code'],
    ['pnpm tsx -e x', 'runs inline code'],
    ['yarn tsx -e x', 'runs inline code'],
    ['pnpm --filter web node -e x', 'runs inline code'],
    ['yarn workspace web node -e x', 'runs inline code'],
    ['yarn run node -e x', 'runs inline code'],
    ['pnpm git status', 'runs git, which does not verify a change'],
    ['pnpm --filter web install', 'runs a setup command (pnpm install)'],
    ['pnpm --filter web dlx vitest', 'downloads and runs a package (pnpm dlx)'],
    ['hatch run python -c x', 'runs inline code'],
    ['hatch run test:python -c x', 'runs inline code'],
    ['conda run python -c x', 'runs inline code'],
    ['pixi run python -c x', 'runs inline code'],
    ['rye run python -c x', 'runs inline code'],
    ['mise exec -- node -e x', 'runs inline code'],
    ['mise exec node@20 -- node -e x', 'runs mise exec without -- before its program'],
    ['mise x node -v', 'runs mise x without -- before its program'],
    ['npm explore lodash -- ls', 'runs another command line through npm explore'],
    ['npx --no-install --yes cowsay', 'runs npx with --yes, which downloads a missing package'],
    ['npx --no-install -y cowsay', 'runs npx with --yes, which downloads a missing package'],
    [
      'npx --no-install --yes=true cowsay',
      'runs npx with --yes, which downloads a missing package',
    ],
    [
      'npm exec --no-install --yes cowsay',
      'runs npm exec with --yes, which downloads a missing package',
    ],
    ['npm it', 'runs a setup command (npm it)'],
    ['npm cit', 'runs a setup command (npm cit)'],
    ['npm install-test', 'runs a setup command (npm install-test)'],
    ['npm install-ci-test', 'runs a setup command (npm install-ci-test)'],
    ['npm rebuild', 'runs a setup command (npm rebuild)'],
    ['pip wheel .', 'runs a setup command (pip wheel)'],
    ['gradle -I init.gradle test', 'runs inline code'],
    ['gradle --init-script x.gradle test', 'runs inline code'],
    ['rake -r ./x test', 'runs inline code'],
    ['rake --require ./x test', 'runs inline code'],
    ['make -sC sub test', 'runs make in another directory or on another file'],
    ['make -I inc test', 'runs make in another directory or on another file'],
    ['just -f other test', 'runs just in another directory or on another file'],
    ['make check DESTDIR=/', 'names a path outside the run workspace'],
    ['gcc -o/tmp/x a.c', 'names a path outside the run workspace'],
    ['gcc -I/abs a.c', 'names a path outside the run workspace'],
    ['make check PREFIX=../out', 'names a path outside the run workspace'],
  ])('refuses %s: %s', (command, reason) => {
    expect(reviewerCommandRefusal(command)).toBe(reason);
  });

  it.each([
    ['busybox sh -c id', 'runs another command line through busybox', 'npm test busybox'],
    ['toybox sh -c id', 'runs another command line through toybox', 'npm test toybox'],
    [
      'npx --no-install busybox sh -c id',
      'runs another command line through busybox',
      'npx --no-install vitest run',
    ],
    [
      'npx --no-install toybox sh -c id',
      'runs another command line through toybox',
      'npx --no-install tsc',
    ],
    [
      'pnpm exec busybox sh -c id',
      'runs another command line through busybox',
      'pnpm exec vitest run',
    ],
    ['pnpm exec toybox sh -c id', 'runs another command line through toybox', 'pnpm exec tsc'],
    ['nix-shell --run id', 'runs another command line through nix-shell', 'npm test nix-shell'],
    ['nix run nixpkgs#hello', 'runs another command line through nix', 'npm test nix'],
    ['osascript -e id', 'runs osascript, which does not verify a change', 'npm test osascript'],
    ['sed -n "1e id" package.json', 'runs sed, which does not verify a change', 'npm test sed'],
    ['tar --to-command=id -xf a.tar', 'runs tar, which does not verify a change', 'npm test tar'],
    [
      'tar --checkpoint-action=exec=id -xf a.tar',
      'runs tar, which does not verify a change',
      'npm test tar',
    ],
    ['elixir -e x', 'runs inline code', 'elixir test/check.exs'],
    ['elixir --eval x', 'runs inline code', 'elixir --version'],
    ['iex -e x', 'runs inline code', 'iex test/check.exs'],
    ['iex --eval x', 'runs inline code', 'iex --version'],
    ['erl -eval x', 'runs inline code', 'erl -version'],
    ['erl -s test', 'runs inline code', 'erl -sname check -version'],
    ['erl -run test', 'runs inline code', 'erl -version'],
    ['erl -sname check -eval x', 'runs inline code', 'erl -sname check -version'],
    ['erl -sname check -s test', 'runs inline code', 'erl -sname check -version'],
    ['erl -sname check -run test', 'runs inline code', 'erl -sname check -version'],
    ['groovy -e x', 'runs inline code', 'groovy test/check.groovy'],
    ['scala -e x', 'runs inline code', 'scala test/check.scala'],
    ['kotlin -e x', 'runs inline code', 'kotlin test/check.kts'],
    ['php -B x', 'runs inline code', 'php vendor/bin/phpunit'],
    ['php -R x', 'runs inline code', 'php vendor/bin/phpunit'],
    ['php -F x', 'runs inline code', 'php -f vendor/bin/phpunit'],
    ['php -E x', 'runs inline code', 'php vendor/bin/phpunit'],
    ['php -Bx', 'runs inline code', 'php -dmemory_limit=1G vendor/bin/phpunit'],
    ['php -Rx', 'runs inline code', 'php -c php.ini vendor/bin/phpunit'],
    ['php -Fx', 'runs inline code', 'php -z extension.so vendor/bin/phpunit'],
    ['php -Ex', 'runs inline code', 'php -n vendor/bin/phpunit'],
    ['php -nR x', 'runs inline code', 'php -ndmemory_limit=1G vendor/bin/phpunit'],
    [
      'mvn -Dexec.executable=sh "-Dexec.args=-c id" exec:exec',
      'runs inline code',
      'mvn -Dtest=ExecTest test',
    ],
    ['mvn exec:exec', 'runs inline code', 'mvn test'],
    ['mvn exec:java', 'runs inline code', 'mvn test'],
    ['mvn test exec:help', 'runs inline code', 'mvn test -Dexec.executable=sh'],
    ['mvn antrun:run', 'runs inline code', 'mvn test'],
    ['mvn test antrun:help', 'runs inline code', 'mvn -Dtest=AntrunTest test'],
    ['rails runner \'system "id"\'', 'runs inline code', 'rails test'],
    ['rails r x', 'runs inline code', 'rails test runner'],
    ['mix run -e \'System.cmd "id", []\'', 'runs inline code', 'mix run test/check.exs'],
    ['mix run --eval x', 'runs inline code', 'mix test --exclude eval'],
    ['mix run --eval=x', 'runs inline code', 'mix run test/check.exs'],
    ['mix eval x', 'runs inline code', 'mix test eval'],
    ['elixir --erl "-run os cmd id" x.exs', 'runs inline code', 'elixir -pa ebin test/x.exs'],
    ['iex -r x.exs', 'runs inline code', 'iex -pa ebin test/x.exs'],
    ['groovy -cp lib -e x', 'runs inline code', 'groovy -cp lib test/check.groovy'],
    ['scala -classpath lib -e x', 'runs inline code', 'scala -encoding UTF-8 test/check.scala'],
    ['kotlin -expression x', 'runs inline code', 'kotlin -classpath app.jar MainKt'],
    [
      'mvn org.codehaus.mojo:exec-maven-plugin:3.1.0:exec',
      'runs inline code',
      'mvn org.apache.maven.plugins:maven-surefire-plugin:test',
    ],
    ['mvn org.apache.maven.plugins:maven-antrun-plugin:run', 'runs inline code', 'mvn verify'],
    ['mix do eval x', 'runs inline code', 'mix do compile + test'],
    ['mix do test + run -e x', 'runs inline code', 'mix do compile, test'],
    [
      'mix do deps.get + test',
      'runs a setup command (mix deps.get)',
      'mix do format --check-formatted + test',
    ],
    [
      'mix do test, deps.get',
      'runs a setup command (mix deps.get)',
      'mix test test/deps_get_test.exs',
    ],
  ])('refuses %s: %s, but runs %s', (command, reason, verification) => {
    expect(reviewerCommandRefusal(command)).toBe(reason);
    expect(reviewerCommandRefusal(verification)).toBeNull();
  });

  it.each([
    ['pnpm up', 'runs a setup command (pnpm up)', 'pnpm run up'],
    ['pnpm up x', 'runs a setup command (pnpm up)', 'pnpm run up x'],
    ['yarn up', 'runs a setup command (yarn up)', 'yarn run up'],
    ['yarn up x', 'runs a setup command (yarn up)', 'yarn run up x'],
    ['npm dedupe', 'runs a setup command (npm dedupe)', 'npm run dedupe'],
    ['pnpm dedupe', 'runs a setup command (pnpm dedupe)', 'make dedupe'],
    ['yarn dedupe', 'runs a setup command (yarn dedupe)', 'yarn run dedupe'],
    ['npm prune', 'runs a setup command (npm prune)', 'npm run prune'],
    ['pnpm prune', 'runs a setup command (pnpm prune)', 'make prune'],
    ['npm shrinkwrap', 'runs a setup command (npm shrinkwrap)', 'npm run shrinkwrap'],
    ['pnpm shrinkwrap', 'runs a setup command (pnpm shrinkwrap)', 'make shrinkwrap'],
    ['poetry lock', 'runs a setup command (poetry lock)', 'poetry run pytest'],
    ['uv lock', 'runs a setup command (uv lock)', 'uv run pytest'],
    ['bundle lock', 'runs a setup command (bundle lock)', 'bundle exec rspec'],
    ['cargo generate-lockfile', 'runs a setup command (cargo generate-lockfile)', 'cargo test'],
    ['gradle wrapper', 'runs a setup command (gradle wrapper)', 'gradle test'],
    ['gradle test wrapper', 'runs a setup command (gradle wrapper)', 'make wrapper'],
    ['npm audit fix', 'runs a setup command (npm audit fix)', 'npm audit'],
    ['npm audit --fix', 'runs a setup command (npm audit fix)', 'npm run audit fix'],
    ['pnpm audit fix', 'runs a setup command (pnpm audit fix)', 'pnpm audit'],
    ['pnpm audit --fix', 'runs a setup command (pnpm audit fix)', 'pnpm audit --json'],
    ['yarn audit fix', 'runs a setup command (yarn audit fix)', 'yarn audit'],
    ['yarn audit --fix', 'runs a setup command (yarn audit fix)', 'yarn run audit fix'],
    ['pnpm audit --fix=true', 'runs a setup command (pnpm audit fix)', 'pnpm test --fix'],
    ['corepack', 'downloads and runs a package (corepack)', 'npm test corepack'],
    ['corepack enable', 'downloads and runs a package (corepack)', 'npm run corepack'],
    ['corepack pnpm install', 'downloads and runs a package (corepack)', 'pnpm test'],
    ['corepack --version', 'downloads and runs a package (corepack)', 'npm test'],
    ['corepack yarn test', 'downloads and runs a package (corepack)', 'yarn test'],
    ['pnpm env use 20', 'downloads and runs a package (pnpm env)', 'pnpm run env'],
    ['yarn set version 4', 'downloads and runs a package (yarn set)', 'yarn run set'],
  ])('refuses %s: %s, but runs %s', (command, reason, verification) => {
    expect(reviewerCommandRefusal(command)).toBe(reason);
    expect(reviewerCommandRefusal(verification)).toBeNull();
  });

  it.each([
    'make lock',
    'just lock',
    'rake lock',
    'mvn lock',
    'gradle lock',
    'make up',
    'make generate-lockfile',
    'npm run lock',
    'npm run install',
    'npm run-script lock',
    'npm --prefix x run lock',
    'npm -w web run lock',
  ])('runs the verification target or package script %s', (command) => {
    expect(reviewerCommandRefusal(command)).toBeNull();
  });

  it.each([
    ['npm x foo', 'runs npm exec without --no-install', 'npm run x foo'],
    ['npm exec foo', 'runs npm exec without --no-install', 'npm exec --no-install foo'],
    ['npm --prefix x exec foo', 'runs npm exec without --no-install', 'npm --prefix x test'],
    ['npm -C x x foo', 'runs npm exec without --no-install', 'npm -C x test'],
    ['npm -w x exec foo', 'runs npm exec without --no-install', 'npm -w x test'],
    [
      'npm --workspace x explore foo',
      'runs another command line through npm explore',
      'npm --workspace x run explore',
    ],
    ['npm explore', 'runs another command line through npm explore', 'npm test explore'],
    ['perl -e x', 'runs inline code', 'perl -Mstrict t/x.t'],
    ['perl -Mstrict -e x', 'runs inline code', 'perl -M strict t/x.t'],
    ['perl -Ilib -e x', 'runs inline code', 'perl -Ilib t/x.t'],
    ['perl -mstrict -e x', 'runs inline code', 'perl -mstrict t/x.t'],
    ['perl -xheader -e x', 'runs inline code', 'perl -xheader t/x.t'],
    ['perl -wMstrict -e x', 'runs inline code', 'perl -wMstrict t/x.t'],
    ['php -c php.ini -r x', 'runs inline code', 'php -c php.ini vendor/bin/phpunit'],
    ['php -dmemory_limit=1G -r x', 'runs inline code', 'php -dmemory_limit=1G vendor/bin/phpunit'],
    ['php -z extension.so -r x', 'runs inline code', 'php -z extension.so vendor/bin/phpunit'],
    ['php -cphp.ini -r x', 'runs inline code', 'php -cphp.ini vendor/bin/phpunit'],
    [
      'php -d memory_limit=1G -r x',
      'runs inline code',
      'php -d memory_limit=1G vendor/bin/phpunit',
    ],
  ])('refuses %s: %s, but runs %s', (command, reason, verification) => {
    expect(reviewerCommandRefusal(command)).toBe(reason);
    expect(reviewerCommandRefusal(verification)).toBeNull();
  });

  it.each([
    ['npm config set script-shell evil.sh', 'npm run config'],
    ['npm config delete script-shell', 'npm test config'],
    ['npm config edit', 'npm run config edit'],
    ['npm config get script-shell', 'npm test get'],
    ['npm config list', 'npm test list'],
    ['pnpm config set script-shell evil.sh', 'pnpm run config'],
    ['pnpm config delete script-shell', 'pnpm test config'],
    ['pnpm config edit', 'pnpm run config edit'],
    ['pnpm config get script-shell', 'pnpm test get'],
    ['pnpm config list', 'pnpm test list'],
    ['yarn config set script-shell evil.sh', 'yarn run config'],
    ['yarn config delete script-shell', 'yarn test config'],
    ['yarn config edit', 'yarn run config edit'],
    ['yarn config get script-shell', 'yarn test get'],
    ['yarn config list', 'yarn test list'],
    ['npm pkg set scripts.test=true', 'npm run pkg'],
    ['npm pkg delete scripts.test', 'npm run pkg delete'],
    ['npm pkg fix', 'npm run pkg fix'],
    ['pnpm pkg set scripts.test=true', 'pnpm run pkg'],
    ['pnpm pkg delete scripts.test', 'pnpm run pkg delete'],
    ['pnpm pkg fix', 'pnpm run pkg fix'],
    ['yarn pkg set scripts.test=true', 'yarn run pkg'],
    ['yarn pkg delete scripts.test', 'yarn run pkg delete'],
    ['yarn pkg fix', 'yarn run pkg fix'],
    ['npm version patch', 'npm --version'],
    ['pnpm version patch', 'pnpm --version'],
    ['yarn version patch', 'yarn versions'],
    ['npm --prefix x config set script-shell evil.sh', 'npm --prefix x run config'],
    ['pnpm --filter web config set script-shell evil.sh', 'pnpm --filter web test'],
    ['yarn --cwd web version patch', 'yarn --cwd web test'],
  ])('refuses the package mutation %s, but runs %s', (command, verification) => {
    expect(reviewerCommandRefusal(command)).toMatch(
      /^runs (npm|pnpm|yarn) (config|pkg|version), which changes package state$/,
    );
    expect(reviewerCommandRefusal(verification)).toBeNull();
  });

  it.each([
    [
      'find . -delete',
      'runs find -delete, which changes files or runs commands',
      'find . -name delete',
    ],
    [
      'find . -exec id +',
      'runs find -exec, which changes files or runs commands',
      'find . -name exec',
    ],
    [
      'find . -execdir id +',
      'runs find -execdir, which changes files or runs commands',
      'find . -name execdir',
    ],
    ['find . -ok id +', 'runs find -ok, which changes files or runs commands', 'find . -name ok'],
    [
      'find . -okdir id +',
      'runs find -okdir, which changes files or runs commands',
      'find . -name okdir',
    ],
    ['nc localhost 1234', 'runs nc, which does not verify a change', 'npm test nc'],
    ['ncat localhost 1234', 'runs ncat, which does not verify a change', 'npm test ncat'],
    ['socat -V', 'runs socat, which does not verify a change', 'npm test socat'],
    ['telnet localhost', 'runs telnet, which does not verify a change', 'npm test telnet'],
    ['ftp localhost', 'runs ftp, which does not verify a change', 'npm test ftp'],
    ['sftp localhost', 'runs sftp, which does not verify a change', 'npm test sftp'],
  ])('refuses %s: %s, but runs %s', (command, reason, verification) => {
    expect(reviewerCommandRefusal(command)).toBe(reason);
    expect(reviewerCommandRefusal(verification)).toBeNull();
  });
});

describe('interpreterScript', () => {
  it('names the project script an interpreter runs, through a forwarder too', () => {
    expect(interpreterScript('python manage.py test')).toBe('manage.py');
    expect(interpreterScript('php artisan test')).toBe('artisan');
    expect(interpreterScript('node ./scripts/check.js --fast')).toBe('scripts/check.js');
    expect(interpreterScript('uv run python manage.py test')).toBe('manage.py');
    expect(interpreterScript('uv run --group dev python scripts/check.py')).toBe(
      'scripts/check.py',
    );
    expect(interpreterScript('conda run -n py312 python manage.py test')).toBe('manage.py');
    expect(interpreterScript('hatch run --verbose test:python manage.py test')).toBe('manage.py');
    expect(interpreterScript('uv run --group dev conda run -n py312 python manage.py test')).toBe(
      'manage.py',
    );
    expect(interpreterScript('npx --no-install tsx scripts/check.ts')).toBe('scripts/check.ts');
    expect(interpreterScript('python3.12 manage.py test')).toBe('manage.py');
    expect(interpreterScript('pnpm node scripts/check.js')).toBe('scripts/check.js');
    expect(interpreterScript('node --test test/new.test.js')).toBe('test/new.test.js');
    expect(interpreterScript('groovy -cp lib test/check.groovy')).toBe('test/check.groovy');
    expect(interpreterScript('elixir -pa ebin test/x.exs')).toBe('test/x.exs');
  });

  it('names the script file bun and deno run, and no package script or test run', () => {
    expect(interpreterScript('bun scripts/check.ts')).toBe('scripts/check.ts');
    expect(interpreterScript('bun run scripts/check.ts')).toBe('scripts/check.ts');
    expect(interpreterScript('deno run -A scripts/check.ts')).toBe('scripts/check.ts');
    expect(interpreterScript('bun run test')).toBeNull();
    expect(interpreterScript('bun test')).toBeNull();
    expect(interpreterScript('deno test')).toBeNull();
  });

  it('names no script for a module, a bare program or a non-interpreter', () => {
    expect(interpreterScript('python -m pytest')).toBeNull();
    expect(interpreterScript('node --version')).toBeNull();
    expect(interpreterScript('npm test')).toBeNull();
    expect(interpreterScript('deno test')).toBeNull();
  });
});

describe('REVIEWER_COMMAND_RULES', () => {
  it('states the rules the policy enforces', () => {
    const text = REVIEWER_COMMAND_RULES.join('\n');
    expect(text).toContain('`./mvnw`');
    expect(text).toContain('`npx --no-install <tool>`');
    expect(text).toContain('`install`');
    expect(text).toContain('`git`');
    expect(text).toContain('`bundle exec`');
    expect(text).toContain('this run changed is refused');
    expect(text).toContain('`make --eval`');
    expect(text).toContain('`rake -e`');
    expect(text).toContain('`just -c`');
    expect(text).toContain('`SHELL`');
    expect(text).toContain('`make -f`');
    expect(text).not.toContain('`mvn -f`');
    expect(text).not.toContain('`gradle -b`');
    expect(text).not.toContain('`rake --rakefile`');
    expect(REVIEWER_COMMAND_RULES[3]).toContain('`rake --require`');
    expect(REVIEWER_COMMAND_RULES[3]).toContain('`gradle --init-script`');
    expect(text).toContain('Every non-option word after the subcommand');
    expect(text).toContain('`uv run --with`');
    expect(text).toContain('`gradle --init-script`');
    expect(text).toContain('`npm explore`');
    expect(text).toContain('`hatch run`');
    expect(text).toContain('`--yes`');
    expect(text).toContain('`install-test`');
    expect(text).toContain('control character');
    for (const form of [
      'busybox',
      'toybox',
      'nix-shell',
      'nix',
      'osascript',
      'sed',
      'tar',
      'elixir -e',
      'elixir --erl',
      'iex -e',
      'erl -eval',
      'erl -s',
      'erl -run',
      'groovy -e',
      'scala -e',
      'kotlin -e',
      'php -B',
      'php -R',
      'php -F',
      'php -E',
      'mvn exec:*',
      'mvn antrun:*',
      'mvn org.codehaus.mojo:exec-maven-plugin:*',
      'mix do',
      'rails runner',
      'rails r',
      'mix -e',
      'mix --eval',
      'mix eval',
      'corepack',
      'pnpm env',
      'yarn set',
      'pnpm up',
      'yarn up',
      'poetry lock',
      'uv lock',
      'bundle lock',
      'cargo generate-lockfile',
      'gradle wrapper',
      'npm dedupe',
      'npm prune',
      'npm shrinkwrap',
      'npm config',
      'pnpm config',
      'yarn config',
      'npm pkg',
      'pnpm pkg',
      'yarn pkg',
      'npm version',
      'pnpm version',
      'yarn version',
      '-delete',
      '-exec',
      '-execdir',
      '-ok',
      '-okdir',
      'nc',
      'ncat',
      'socat',
      'telnet',
      'ftp',
      'sftp',
    ])
      expect(text).toContain(`\`${form}\``);
  });
});
