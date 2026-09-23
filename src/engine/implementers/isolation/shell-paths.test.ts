import { describe, expect, it } from 'vitest';
import { readShellCommand } from './shell-paths.js';

const scope = { cwd: '/wt', home: '/Users/me', tmpdir: '/var/folders/xy/T' };

function reaches(command: string): string[] {
  return readShellCommand(command, scope).references.map(
    (reference) => `${reference.access} ${reference.path}${reference.followsLink ? '' : ' (name)'}`,
  );
}

describe('readShellCommand', () => {
  it('reads the searches agy ran from its scratch directory in the 2026-09-23 run', () => {
    expect(reaches('find /Users/me -name "process-invoke.ts" 2>/dev/null')).toEqual([
      'write /dev/null',
      'search /Users/me',
    ]);
    expect(reaches(`grep -rn '"name": "splitbrief"' /Users/me/Projects/ 2>/dev/null`)).toEqual([
      'write /dev/null',
      'search /Users/me/Projects',
    ]);
  });

  it('names nothing for commands that take no paths', () => {
    expect(reaches('pwd')).toEqual([]);
    expect(reaches('echo "$HOME" && printf "%s" /Users/me')).toEqual([]);
    expect(reaches('npm test')).toEqual([]);
    expect(reaches('git status && git diff --stat')).toEqual([]);
    expect(reaches('git commit -am "move /Users/me/old to src"')).toEqual([]);
  });

  it('resolves relative operands against the working directory', () => {
    expect(reaches('pwd; ls -la README.md')).toEqual(['list /wt/README.md']);
    expect(reaches('cat src/a.ts | head -5')).toEqual(['read /wt/src/a.ts']);
    expect(reaches('npx vitest run src/a.test.ts')).toEqual([
      'read /wt/run',
      'read /wt/src/a.test.ts',
    ]);
  });

  it('keeps a pattern, a script and a message out of the paths', () => {
    expect(reaches('grep -n "/Users/me" src/a.ts')).toEqual(['read /wt/src/a.ts']);
    expect(reaches('rg -e /Users/me src')).toEqual(['search /wt/src']);
    expect(reaches("sed -i '' '/foo/d' src/a.ts")).toEqual(['write /wt/src/a.ts']);
    expect(reaches("awk '/Users/ {print}' notes.txt")).toEqual(['read /wt/notes.txt']);
    expect(reaches('node -e "require(\'/abs/x\')" script.mjs')).toEqual(['read /wt/script.mjs']);
  });

  it('expands the home, the temp directory and the working directory the shell would', () => {
    expect(reaches('ls ~')).toEqual(['list /Users/me']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the command must carry a literal shell ${HOME}
    expect(reaches('cat $HOME/.ssh/id_rsa ${HOME}/.npmrc')).toEqual([
      'read /Users/me/.ssh/id_rsa',
      'read /Users/me/.npmrc',
    ]);
    expect(reaches('touch "$TMPDIR/probe"')).toEqual(['write /var/folders/xy/T/probe']);
    expect(reaches('cat $PWD/a.ts')).toEqual(['read /wt/a.ts']);
    expect(reaches('cat $SOMEWHERE/a.ts $(pwd)/b.ts')).toEqual([]);
  });

  it('takes a lone `/` operand of an unknown command for a delimiter, not the root', () => {
    for (const command of ['cut -d / -f1 a.txt', 'tr / _', 'sort -t / f', 'paste -d / a b']) {
      expect(reaches(command), command).not.toContain('read /');
    }
    expect(reaches('ls /')).toEqual(['list /']);
    expect(reaches('find /')).toEqual(['search /']);
  });

  it('cuts a word at its first glob', () => {
    expect(reaches('ls /Users/me/Projects/*/package.json')).toEqual(['list /Users/me/Projects']);
  });

  it('follows the working directory through cd and git -C', () => {
    expect(reaches('cd ~/Projects/other && cat a.ts')).toEqual([
      'read /Users/me/Projects/other',
      'read /Users/me/Projects/other/a.ts',
    ]);
    expect(reaches('git -C /Users/me/Projects/app diff src/a.ts')).toEqual([
      'read /Users/me/Projects/app',
      'read /Users/me/Projects/app/src/a.ts',
    ]);
  });

  it('reads what a nested shell, a substitution and a find -exec run', () => {
    expect(reaches('bash -lc "cat ~/.ssh/config"')).toEqual(['read /Users/me/.ssh/config']);
    expect(reaches('cat $(find /Users/me -name x)')).toEqual(['search /Users/me']);
    expect(reaches('find . -name "*.log" -exec cp {} /Users/me/logs \\;')).toEqual([
      'search /wt',
      'write /Users/me/logs',
    ]);
    expect(reaches('xargs rm -rf /Users/me/cache')).toEqual(['write /Users/me/cache (name)']);
  });

  it('classifies writes by command and redirection', () => {
    expect(reaches('cp /usr/share/dict/words ./words.txt')).toEqual([
      'read /usr/share/dict/words',
      'write /wt/words.txt',
    ]);
    expect(reaches('echo x > node_modules/pkg/index.js')).toEqual([
      'write /wt/node_modules/pkg/index.js',
    ]);
    expect(reaches('rm -rf node_modules')).toEqual(['write /wt/node_modules (name)']);
    expect(reaches('rm -rf node_modules/')).toEqual(['write /wt/node_modules']);
    expect(reaches('tee -a /Users/me/.zshrc < notes.txt')).toEqual([
      'read /wt/notes.txt',
      'write /Users/me/.zshrc',
    ]);
  });

  it('reads a package install as a write to the node_modules it changes', () => {
    expect(reaches('npm install lodash')).toEqual(['write /wt/node_modules', 'read /wt/lodash']);
    expect(reaches('pnpm add -D vitest')).toEqual(['write /wt/node_modules', 'read /wt/vitest']);
    expect(reaches('yarn')).toEqual(['write /wt/node_modules']);
    expect(reaches('npm ci --prefix /Users/me/app')).toEqual([
      'read /Users/me/app',
      'write /Users/me/app/node_modules',
    ]);
    expect(reaches('npm run build')).toEqual(['read /wt/build']);
    expect(reaches('npm install -g typescript')).toEqual(['read /wt/typescript']);
    expect(reaches('npm link')).toEqual([]);
    expect(reaches('npx vitest run')).toEqual(['read /wt/run']);
  });

  it('keeps reading after an arithmetic expansion that ends a command', () => {
    expect(reaches('i=$((i+1));cat ~/.ssh/id_rsa')).toEqual(['read /Users/me/.ssh/id_rsa']);
  });

  it('skips a here-document body, which is data rather than paths', () => {
    const command =
      "cat > /tmp/x.ts <<'EOF'\nconst home = '/Users/me/secret';\nEOF\nnode /tmp/x.ts";
    expect(reaches(command)).toEqual(['write /tmp/x.ts', 'read /tmp/x.ts']);
  });
});
