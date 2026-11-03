import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_AVAILABILITY = {
  isAvailable: async (): Promise<boolean> => true,
  getVersion: async (): Promise<string | null> => null,
};

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandResolves(command: string): Promise<boolean> {
  if (isAbsolute(command) || command.includes('/')) {
    return isExecutable(resolve(command));
  }
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await isExecutable(join(dir, command))) return true;
  }
  return false;
}

type CommandCandidates = string | readonly string[] | undefined;

function normalizeCommandCandidates(commands: CommandCandidates): readonly string[] {
  if (commands === undefined) return [];
  return typeof commands === 'string' ? [commands] : commands;
}

async function commandCandidatesResolve(commands: readonly string[]): Promise<boolean> {
  for (const command of commands) {
    if (await commandResolves(command)) return true;
  }
  return false;
}

export function createCommandExistsAvailability(commands: CommandCandidates) {
  const candidates = normalizeCommandCandidates(commands);
  if (candidates.length === 0) {
    return {
      isAvailable: async (): Promise<boolean> => false,
      getVersion: async (): Promise<string | null> => null,
    };
  }
  let cached: Promise<boolean> | undefined;
  const probe = () => (cached ??= commandCandidatesResolve(candidates));
  return {
    isAvailable: () => probe(),
    getVersion: async (): Promise<string | null> => null,
  };
}
