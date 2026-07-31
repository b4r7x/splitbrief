import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('serves an interactive, accessible built shell and preserves a real 404', async ({
  page,
  request,
}) => {
  const consoleErrors: string[] = [];
  const failedResources: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const resourceType = response.request().resourceType();
      failedResources.push(`${resourceType}: ${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (failedRequest) => {
    const failure = failedRequest.failure();
    failedResources.push(
      `${failedRequest.resourceType()}: ${failedRequest.url()} (${
        failure ? failure.errorText : 'unknown request failure'
      })`,
    );
  });

  const homeResponse = await page.goto('/');

  expect(homeResponse?.status()).toBe(200);
  await page.waitForLoadState('networkidle');

  const shell = page.locator('.landing-shell[data-theme="dark"]');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveText('Patch any planner into any implementer.');
  await expect(shell).toBeVisible();

  const matrix = page.getByRole('region', { name: 'Planner and implementer pairing' });
  await expect(matrix.locator('.matrix__controls')).not.toHaveAttribute('inert', '');
  const grid = matrix.getByRole('grid', { name: 'Planner × implementer pairings' });
  const nextPairing = grid.getByRole('gridcell', { name: 'Codex LM Studio' });
  await nextPairing.click();
  await expect(nextPairing).toHaveAttribute('aria-selected', 'true');
  await expect(matrix.getByRole('status')).toHaveText('Config updated: codex × lm-studio');
  await expect(
    matrix.getByRole('figure', { name: 'Generated config' }).locator('code'),
  ).toContainText('tool: codex');

  const axeResults = await new AxeBuilder({ page }).analyze();
  const unreviewedSevereIncomplete = axeResults.incomplete
    .filter(
      (result) =>
        (result.impact === 'critical' || result.impact === 'serious') &&
        result.id !== 'color-contrast',
    )
    .map((result) => ({
      id: result.id,
      impact: result.impact,
      targets: result.nodes.map((node) => node.target),
    }));
  expect(
    [...axeResults.passes, ...axeResults.incomplete, ...axeResults.violations].some(
      (result) => result.id === 'color-contrast',
    ),
  ).toBe(true);
  expect(
    axeResults.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  expect(unreviewedSevereIncomplete).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedResources).toEqual([]);
  expect(pageErrors).toEqual([]);

  const missingResponse = await request.get('/this-route-does-not-exist');
  expect(missingResponse.status()).toBe(404);
});
