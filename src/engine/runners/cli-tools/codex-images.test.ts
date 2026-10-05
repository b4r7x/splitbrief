import { describe, expect, it } from 'vitest';
import { codexPlannerAdapter } from './codex.js';

describe('Codex review image argv', () => {
  it.each([undefined, [], ['/tmp/dashboard.png', '/tmp/settings panel.png']])(
    'emits one --image pair for each delivered path: %j',
    (imagePaths) => {
      const args = codexPlannerAdapter.buildArgs({
        prompt: 'Review the dashboard.',
        mode: 'plan',
        sessionId: null,
        oneShot: true,
        projectDir: '/project',
        model: undefined,
        effort: undefined,
        configuredArgs: [],
        imagePaths,
      });
      expect(args.filter((arg) => arg === '--image')).toHaveLength(imagePaths?.length ?? 0);
      if (imagePaths === undefined || imagePaths.length === 0) {
        expect(args).not.toContain('--image');
      } else {
        const start = args.indexOf('exec') + 1;
        expect(args.slice(start, start + 4)).toEqual([
          '--image',
          '/tmp/dashboard.png',
          '--image',
          '/tmp/settings panel.png',
        ]);
      }
      expect(args).toContain('--ephemeral');
      expect(args.at(-1)).toBe('-');
    },
  );
});
