import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const configV3WriterHelperPath = fileURLToPath(import.meta.url);

type ConfigDocumentEdit = {
  path: readonly string[];
  value: unknown;
};

type WriterInput = {
  identityRoot: string;
  projectDir: string;
  rawYaml: string;
  edits: ConfigDocumentEdit[];
  operation: 'write' | 'load';
};

type ConfigIoModule = {
  loadConfig: (projectDir: string) => unknown;
  writeConfigDocument: (
    projectDir: string,
    rawYaml: string,
    edits: readonly ConfigDocumentEdit[],
  ) => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string.`);
  return value;
}

function readEdits(value: unknown): ConfigDocumentEdit[] {
  if (!Array.isArray(value)) throw new Error('Expected edits to be an array.');

  return value.map((edit) => {
    if (!isRecord(edit)) throw new Error('Expected every edit to be an object.');
    if (!Object.hasOwn(edit, 'value')) throw new Error('Expected every edit to include value.');
    if (!Array.isArray(edit.path) || edit.path.some((segment) => typeof segment !== 'string')) {
      throw new Error('Expected every edit path to be a string array.');
    }

    return { path: edit.path, value: edit.value };
  });
}

function readInput(raw: string | undefined): WriterInput {
  if (raw === undefined) throw new Error('Expected one JSON input argument.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Expected valid JSON input.');
  }

  if (!isRecord(parsed)) throw new Error('Expected a JSON object input.');
  const operation = readString(parsed, 'operation');
  if (operation !== 'write' && operation !== 'load') {
    throw new Error('Expected operation to be write or load.');
  }

  return {
    identityRoot: readString(parsed, 'identityRoot'),
    projectDir: readString(parsed, 'projectDir'),
    rawYaml: readString(parsed, 'rawYaml'),
    edits: readEdits(parsed['edits']),
    operation,
  };
}

function isConfigIoModule(value: unknown): value is ConfigIoModule {
  return (
    isRecord(value) &&
    typeof value.loadConfig === 'function' &&
    typeof value.writeConfigDocument === 'function'
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runConfigV3Writer(): Promise<void> {
  try {
    const input = readInput(process.argv[2]);
    const sourcePath = resolve(input.identityRoot, 'src/core/config/load/io.ts');
    const imported: unknown = await import(pathToFileURL(sourcePath).href);
    if (!isConfigIoModule(imported)) {
      throw new Error('The supplied identity does not export the config document writer.');
    }

    if (input.operation === 'load') {
      imported.loadConfig(input.projectDir);
      process.stdout.write(JSON.stringify({ kind: 'loaded' }));
      return;
    }

    const text = imported.writeConfigDocument(input.projectDir, input.rawYaml, input.edits);
    process.stdout.write(JSON.stringify({ kind: 'saved', sha256: sha256(text) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ kind: 'error', message: errorMessage(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === configV3WriterHelperPath) {
  await runConfigV3Writer();
}
