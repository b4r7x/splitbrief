import { expect, test } from '@playwright/test';

test('keeps the static search engine off the docs critical path', async ({ page }) => {
  const searchRequests: string[] = [];
  const searchResponses: number[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/search') {
      searchRequests.push(request.method());
    }
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/search') {
      searchResponses.push(response.status());
    }
  });

  await page.goto('/docs/getting-started/introduction');
  const searchTrigger = page.getByRole('button', { name: 'Search' });
  await expect(searchTrigger).toBeEnabled();

  expect(searchRequests).toEqual([]);
  expect(searchResponses).toEqual([]);

  await searchTrigger.click();
  const searchbox = page.getByRole('searchbox');
  await searchbox.fill('splitbrief.config.ts');
  const bodyResult = page.getByRole('link', {
    name: 'Configuration — Documentation / Reference',
    exact: true,
  });
  await expect(bodyResult).toHaveAttribute('href', '/docs/reference/configuration');
  await expect(bodyResult.locator('.docs-search__breadcrumbs')).toHaveText(
    'Documentation / Reference',
  );
  await expect
    .poll(() => ({ requests: searchRequests, responses: searchResponses }))
    .toEqual({
      requests: ['GET'],
      responses: [200],
    });

  await searchbox.fill('CLI');
  const titleResult = page.getByRole('link', {
    name: 'CLI — Documentation / Reference',
    exact: true,
  });
  await expect(titleResult).toHaveAttribute('href', '/docs/reference/cli');
  await expect(titleResult.locator('.docs-search__breadcrumbs')).toHaveText(
    'Documentation / Reference',
  );
  await expect
    .poll(() => ({ requests: searchRequests, responses: searchResponses }))
    .toEqual({
      requests: ['GET'],
      responses: [200],
    });
});
