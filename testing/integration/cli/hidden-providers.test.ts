import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { addWorkflowOptions } from '../../../src/cli/options/workflow.js';
import { LOCAL_API_PROVIDER_IDS } from '../../../src/core/providers/api-catalog.js';
import { detectProviderCatalogs } from '../../../src/engine/providers/catalog-detection.js';
import { localConnectionProvider } from '../../../src/features/runners/local-connection/model.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
} from '../../../src/features/runners/model-catalog/options.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

// Each surface below hides the providers of the hidden list; with a list that leaves them out,
// the same surfaces offer them again.
vi.mock('../../../src/core/providers/hidden.js', () => ({ HIDDEN_API_PROVIDER_IDS: [] }));

describe('a local provider that the hidden list leaves out', () => {
  setupFetchMock();

  it('has a picker row, and the row of a server that does not answer opens its form', () => {
    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: LOCAL_API_PROVIDER_IDS.map((provider) => ({
          provider,
          available: false,
          isLocal: true,
        })),
      },
      undefined,
    );
    const local = options.filter((item) => item.kind === 'api');

    expect(local.map((item) => item.id).sort()).toEqual([...LOCAL_API_PROVIDER_IDS].sort());
    expect(local.map(localConnectionProvider)).toEqual(local.map((item) => item.id));
  });

  it('is probed by the provider detection of setup and doctor', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Connection refused'));

    const outcomes = await detectProviderCatalogs();

    expect(outcomes.map((outcome) => outcome.provider)).toEqual([...LOCAL_API_PROVIDER_IDS]);
  });

  it('is named by the runner options of the CLI', () => {
    const help = addWorkflowOptions(new Command()).helpInformation().replace(/\s+/g, ' ');

    for (const provider of LOCAL_API_PROVIDER_IDS) expect(help).toContain(provider);
  });
});
