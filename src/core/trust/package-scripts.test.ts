import { describe, expect, it } from 'vitest';
import {
  isPackageManagerScriptInvocation,
  packageManagerScriptName,
  packageManagerScriptNames,
  scriptsRunFor,
} from './package-scripts.js';

describe('isPackageManagerScriptInvocation', () => {
  it.each([
    ['npm run build', ['npm', 'run', 'build']],
    ['npm test', ['npm', 'test']],
    ['pnpm run build', ['pnpm', 'run', 'build']],
    ['yarn run build', ['yarn', 'run', 'build']],
    ['bun run build', ['bun', 'run', 'build']],
    ['npm --silent run build', ['npm', '--silent', 'run', 'build']],
    ['npm run --if-present build', ['npm', 'run', '--if-present', 'build']],
    ['npm rum build', ['npm', 'rum', 'build']],
    ['npm ur build', ['npm', 'ur', 'build']],
    ['npm run-s build', ['npm', 'run-s', 'build']],
    ['npm runS build', ['npm', 'runS', 'build']],
    ['npm t', ['npm', 't']],
    ['npm res', ['npm', 'res']],
    ['yarn build', ['yarn', 'build']],
    ['yarnpkg check', ['yarnpkg', 'check']],
    ['pnpm build', ['pnpm', 'build']],
    ['bun build', ['bun', 'build']],
  ])('flags package script execution for %s', (_label, tokens) => {
    expect(isPackageManagerScriptInvocation(tokens)).toBe(true);
  });

  it.each([
    ['npm rum build', ['npm', 'rum', 'build'], 'build'],
    ['npm runScript build', ['npm', 'runScript', 'build'], 'build'],
    ['npm tst', ['npm', 'tst'], 'test'],
    ['npm sto', ['npm', 'sto'], 'stop'],
    ['yarn --silent build', ['yarn', '--silent', 'build'], 'build'],
    ['yarnpkg check', ['yarnpkg', 'check'], 'check'],
    ['pnpm test:unit', ['pnpm', 'test:unit'], 'test:unit'],
    ['bun run build', ['bun', 'run', 'build'], 'build'],
  ])('names the script that %s runs', (_label, tokens, script) => {
    expect(packageManagerScriptName(tokens)).toBe(script);
  });

  it.each([
    ['npm install', ['npm', 'install']],
    ['npm i', ['npm', 'i']],
    ['npm in', ['npm', 'in']],
    ['npm ins', ['npm', 'ins']],
    ['npm inst', ['npm', 'inst']],
    ['npm add lodash', ['npm', 'add', 'lodash']],
    ['npm isntall', ['npm', 'isntall']],
    ['npm ci', ['npm', 'ci']],
    ['npm clean-install', ['npm', 'clean-install']],
    ['npm ic', ['npm', 'ic']],
    ['npm install-clean', ['npm', 'install-clean']],
    ['npm isntall-clean', ['npm', 'isntall-clean']],
  ])('names install for %s', (_label, tokens) => {
    expect(packageManagerScriptName(tokens)).toBe('install');
    expect(isPackageManagerScriptInvocation(tokens)).toBe(true);
  });

  it.each([
    ['NPM run check', ['check']],
    ['timeout 5 npm run check', ['check']],
    ['npx npm run check', ['check']],
    ['npx npm@10 run check', ['check']],
    ['pnpm exec npm run check', ['exec', 'check']],
    ['npm exec -- yarn check', ['check']],
    ['yarnpkg check', ['check']],
    ['prettier --check README.md', []],
  ])('names the scripts that each package manager in %s runs', (command, scripts) => {
    expect(packageManagerScriptNames(command.split(' '))).toEqual(scripts);
  });

  it.each([
    ['npm help', ['npm', 'help']],
    ['npm run without a script', ['npm', 'run']],
    ['node runner', ['node', 'runner']],
  ])('does not flag non-script package manager commands for %s', (_label, tokens) => {
    expect(isPackageManagerScriptInvocation(tokens)).toBe(false);
  });

  it.each([
    ['check', ['precheck', 'check', 'postcheck']],
    [
      'restart',
      [
        'prestop',
        'stop',
        'poststop',
        'prerestart',
        'restart',
        'postrestart',
        'prestart',
        'start',
        'poststart',
      ],
    ],
    [
      'install',
      [
        'preinstall',
        'install',
        'postinstall',
        'prepublish',
        'preprepare',
        'prepare',
        'postprepare',
      ],
    ],
  ])('names the scripts a package manager runs for %s', (script, scripts) => {
    expect(scriptsRunFor(script)).toEqual(scripts);
  });
});
