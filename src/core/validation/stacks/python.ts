import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidationStage } from '../../schemas/enums.js';
import type { Stack } from './types.js';

export const PYPROJECT_SECTIONS: Readonly<
  Record<ValidationStage, { section: string; command: string }>
> = {
  typecheck: { section: '[tool.mypy]', command: 'mypy .' },
  lint: { section: '[tool.ruff]', command: 'ruff check .' },
  test: { section: '[tool.pytest.ini_options]', command: 'pytest' },
};

export function hasPyprojectSection(projectDir: string, section: string): boolean {
  const pyproject = join(projectDir, 'pyproject.toml');
  if (!existsSync(pyproject)) return false;
  return readFileSync(pyproject, 'utf-8').includes(section);
}

function has(projectDir: string, file: string): boolean {
  return existsSync(join(projectDir, file));
}

export const pythonStack: Stack = {
  id: 'python',
  language: 'python',
  markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
  typecheck: (projectDir) => {
    const { section, command } = PYPROJECT_SECTIONS.typecheck;
    if (hasPyprojectSection(projectDir, section) || has(projectDir, 'mypy.ini')) return command;
    if (has(projectDir, 'pyrightconfig.json')) return 'pyright';
    return null;
  },
  lint: (projectDir) => {
    const { section, command } = PYPROJECT_SECTIONS.lint;
    if (hasPyprojectSection(projectDir, section) || has(projectDir, 'ruff.toml')) return command;
    if (has(projectDir, '.flake8')) return 'flake8';
    return null;
  },
  test: (projectDir) => {
    if (has(projectDir, 'uv.lock')) return 'uv run pytest';
    if (has(projectDir, 'poetry.lock')) return 'poetry run pytest';
    return 'pytest';
  },
  testFilePatterns: ['test_*.py', '*_test.py'],
  testDirs: ['tests', 'test'],
  narrowing: { kind: 'path-arg', separator: '' },
  allowedCommands: ['pytest', 'mypy', 'ruff', 'flake8', 'pyright', 'uv', 'poetry', 'python'],
};
