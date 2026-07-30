import { compile, createProcessor } from '@mdx-js/mdx';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { describe, expect, it } from 'vitest';
import sourceConfig from '../source.config.js';
import { remarkContentSecurity } from './remark-content-security.js';

const MDX_OPTIONS = {
  remarkPlugins: [remarkContentSecurity],
};

const UNSAFE_MDX = [
  {
    message: 'ESM import/export',
    source: 'export const answer = 42',
  },
  {
    message: 'flow expression',
    source: '{answer}',
  },
  {
    message: 'text expression',
    source: 'The answer is {answer}.',
  },
  {
    message: 'flow JSX',
    source: '<Callout>Unsafe</Callout>',
  },
  {
    message: 'inline JSX',
    source: 'An inline <Callout /> component.',
  },
  {
    message: 'unsafe URL scheme',
    source: '[Unsafe](javascript:alert)',
  },
] as const;

describe('remarkContentSecurity', () => {
  it('runs from the Fumadocs compiler configuration', async () => {
    const configuredInput =
      typeof sourceConfig.mdxOptions === 'function'
        ? await sourceConfig.mdxOptions()
        : sourceConfig.mdxOptions;
    const configuredOptions = await applyMdxPreset(configuredInput)('bundler');

    await expect(
      compile(
        {
          path: 'content/docs/configured-boundary.mdx',
          value: ['## Safe', '', 'Unsafe on the next line:', '', '{process.env.API_KEY}'].join(
            '\n',
          ),
        },
        configuredOptions,
      ),
    ).rejects.toMatchObject({
      file: expect.stringContaining('content/docs/configured-boundary.mdx'),
      line: 5,
      reason: expect.stringContaining('flow expression'),
    });
  });

  it('allows inert documentation through the actual MDX compiler', async () => {
    const source = [
      '## Configure the runner',
      '',
      'Use [the reference](https://example.com/reference) and `process.env.API_KEY`.',
      '',
      '```tsx',
      'export const example = <Callout>{answer}</Callout>;',
      '```',
      '',
    ].join('\n');

    await expect(
      compile({ path: 'content/docs/safe.mdx', value: source }, MDX_OPTIONS),
    ).resolves.toMatchObject({
      path: expect.stringContaining('content/docs/safe.mdx'),
    });
  });

  it.each(UNSAFE_MDX)('rejects $message before MDX emits JavaScript', async (fixture) => {
    await expect(
      compile({ path: 'content/docs/unsafe.mdx', value: fixture.source }, MDX_OPTIONS),
    ).rejects.toMatchObject({
      fatal: true,
      line: 1,
      reason: expect.stringContaining(fixture.message),
      ruleId: 'content-security',
      source: 'splitbrief',
    });
  });

  it('rejects raw HTML through the Markdown processor used for .md documents', async () => {
    const processor = createProcessor({
      format: 'md',
      remarkPlugins: [remarkContentSecurity],
    });

    await expect(
      processor.process({
        path: 'content/docs/unsafe.md',
        value: '<iframe src="https://example.com"></iframe>',
      }),
    ).rejects.toMatchObject({
      fatal: true,
      line: 1,
      reason: expect.stringContaining('raw HTML'),
      ruleId: 'content-security',
      source: 'splitbrief',
    });
  });

  it('preserves the source file and line in compiler failures', async () => {
    const source = ['## Safe', '', 'More text.', '', '[Unsafe](data:text/html,payload)'].join('\n');

    await expect(
      compile({ path: 'content/docs/line-check.mdx', value: source }, MDX_OPTIONS),
    ).rejects.toMatchObject({
      column: 1,
      file: expect.stringContaining('content/docs/line-check.mdx'),
      line: 5,
    });
  });
});
