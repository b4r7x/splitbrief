import { readFile } from 'node:fs/promises';
import type { Attachment } from '../../core/schemas/attachment.js';

export interface ImageBase64 {
  mime: string;
  data: string;
}

export async function readImagesAsBase64(images: Attachment[]): Promise<ImageBase64[]> {
  return Promise.all(images.map(async img => ({
    mime: img.mimeType,
    data: (await readFile(img.path)).toString('base64'),
  })));
}
