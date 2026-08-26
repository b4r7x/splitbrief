import { assertNever } from '../../utils/type-guards.js';

type CommandStringInterpreterFamily = 'posix-shell' | 'powershell' | 'windows-command';

type CommandStringInterpreterProfile = Readonly<{
  family: CommandStringInterpreterFamily;
  names: readonly string[];
}>;

const COMMAND_STRING_INTERPRETER_PROFILES: readonly CommandStringInterpreterProfile[] = [
  {
    family: 'posix-shell',
    names: ['ash', 'bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh'],
  },
  {
    family: 'powershell',
    names: ['powershell', 'pwsh'],
  },
  {
    family: 'windows-command',
    names: ['cmd'],
  },
];

function executableName(value: string): string {
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return value
    .slice(separator + 1)
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function commandStringInterpreterProfile(
  value: string,
): CommandStringInterpreterProfile | undefined {
  const name = executableName(value);
  return COMMAND_STRING_INTERPRETER_PROFILES.find((profile) => profile.names.includes(name));
}

function consumesPosixShellOptionArgument(value: string): boolean {
  return (
    value === '-O' ||
    value === '+O' ||
    value === '-o' ||
    value === '+o' ||
    value === '--init-file' ||
    value === '--rcfile'
  );
}

function isPosixShellCommandStringOption(value: string): boolean {
  if (value === '-c' || value === '--command' || value.startsWith('--command=')) return true;
  return /^-[A-Za-z]*c[A-Za-z]*$/.test(value);
}

function hasPosixShellCommandStringMode(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || argument === '--' || argument === '-') return false;
    if (!argument.startsWith('-') && !argument.startsWith('+')) return false;
    if (isPosixShellCommandStringOption(argument)) return true;
    if (consumesPosixShellOptionArgument(argument)) index += 1;
  }
  return false;
}

function isPowerShellCommandStringOption(value: string): boolean {
  const option = value.toLowerCase();
  return (
    option === '-c' ||
    option === '-command' ||
    option.startsWith('-command:') ||
    option === '-e' ||
    option === '-enc' ||
    option === '-encodedcommand' ||
    option.startsWith('-encodedcommand:')
  );
}

function consumesPowerShellOptionArgument(value: string): boolean {
  return [
    '-configurationname',
    '-executionpolicy',
    '-inputformat',
    '-outputformat',
    '-settingsfile',
    '-version',
    '-windowstyle',
    '-workingdirectory',
  ].includes(value.toLowerCase());
}

function hasPowerShellCommandStringMode(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || argument === '--' || argument === '-') return false;
    if (!argument.startsWith('-')) return false;
    if (isPowerShellCommandStringOption(argument)) return true;
    if (argument.toLowerCase() === '-file') return false;
    if (consumesPowerShellOptionArgument(argument)) index += 1;
  }
  return false;
}

function hasWindowsCommandStringMode(argv: readonly string[]): boolean {
  for (const argument of argv) {
    if (argument === '--' || argument === '-') return false;
    if (argument.toLowerCase() === '/c' || argument.toLowerCase() === '/k') return true;
    if (!argument.startsWith('/') && !argument.startsWith('-')) return false;
  }
  return false;
}

function hasInterpreterCommandString(executable: string, argv: readonly string[]): boolean {
  const profile = commandStringInterpreterProfile(executable);
  if (profile === undefined) return false;
  switch (profile.family) {
    case 'posix-shell':
      return hasPosixShellCommandStringMode(argv);
    case 'powershell':
      return hasPowerShellCommandStringMode(argv);
    case 'windows-command':
      return hasWindowsCommandStringMode(argv);
    default:
      return assertNever(profile.family);
  }
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function envDispatchesInterpreterCommandString(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) return false;
    if (
      argument === '-S' ||
      argument === '--split-string' ||
      argument.startsWith('--split-string=')
    ) {
      return true;
    }
    if (argument === '--') {
      const executable = argv[index + 1];
      return (
        executable !== undefined && hasInterpreterCommandString(executable, argv.slice(index + 2))
      );
    }
    if (
      isEnvironmentAssignment(argument) ||
      argument === '-i' ||
      argument === '--ignore-environment'
    ) {
      continue;
    }
    if (argument === '-u' || argument === '--unset') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--unset=')) continue;
    if (argument === '-C' || argument === '--chdir') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--chdir=')) continue;
    if (argument.startsWith('-')) return false;
    return hasInterpreterCommandString(argument, argv.slice(index + 1));
  }
  return false;
}

export function storesInterpreterCommandString(
  executable: string,
  argv: readonly string[],
): boolean {
  if (hasInterpreterCommandString(executable, argv)) return true;
  return executableName(executable) === 'env' && envDispatchesInterpreterCommandString(argv);
}
