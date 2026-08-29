import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedModel } from '../../../src/core/discovery/detection.js';
import { parseCursorModels } from '../../../src/engine/providers/cli-model-catalog.js';
import type { ModelOption } from '../../../src/features/runners/model-catalog/recency.js';

const FIXTURE = join(import.meta.dirname, '../../fixtures/cursor/list-models.txt');

function readCursorFixture(): DetectedModel[] {
  const models = parseCursorModels(readFileSync(FIXTURE, 'utf8'));
  if (models === null) throw new Error('cursor list-models fixture failed to parse');
  return models;
}

export function cursorDetectedModels(): DetectedModel[] {
  return readCursorFixture();
}

export function cursorModelOptions(): ModelOption[] {
  return readCursorFixture().map((model) => ({
    id: model.id,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
  }));
}
