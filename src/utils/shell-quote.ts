export function shellCommandFromText(text: string): string | null {
  const prefixes = [
    '/bin/zsh -lc ',
    '/bin/bash -lc ',
    '/bin/sh -lc ',
    'zsh -lc ',
    'bash -lc ',
    'sh -lc ',
  ];
  for (const prefix of prefixes) {
    const index = text.indexOf(prefix);
    if (index < 0) continue;
    const command = text.slice(index + prefix.length).trim();
    if (command.length === 0) return null;
    return shellCommandArgument(command);
  }
  return null;
}

function shellCommandArgument(command: string): string {
  if (command.length < 2) return command;
  const first = command[0];
  if (first !== '"' && first !== "'") return command;

  const quoted = readQuotedShellArgument(command, first);
  return quoted ?? command;
}

function readQuotedShellArgument(command: string, quote: '"' | "'"): string | null {
  let escaped = false;
  for (let index = 1; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return command.slice(1, index);
  }
  return null;
}
