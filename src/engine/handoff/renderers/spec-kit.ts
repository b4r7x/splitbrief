import type { HandoffInput, HandoffPack } from '../types.js';
import { buildBaseFiles } from './shared.js';

export function renderSpecKit(input: HandoffInput): HandoffPack {
  return { files: buildBaseFiles(input) };
}
