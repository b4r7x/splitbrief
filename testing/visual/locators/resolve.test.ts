import { describe, expect, it } from 'vitest';
import { isCellRectOnGraphemeBoundaries, type CellGrid } from '../contracts/cells.js';
import { isCellRectInViewport, viewport } from '../contracts/geometry.js';
import {
  getWorkflowSidebarWidth,
  SIDEBAR_BREAKPOINT_COLS,
} from '../../../src/features/workflow/layout/rect.js';
import { listVisualScenarios } from '../catalog.js';
import { createCropCellGrid } from '../artifacts/crop.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import {
  createFrameGrid,
  RECOVERY_BOUNDARY_VIEWPORTS,
  RECOVERY_SCENARIO_IDS,
  recoveryProfileForColumns,
  recoveryRoleElements,
  requireCheckpoint,
  requireScenario,
  resolveRole,
  roleElement,
} from '../recovery-locators.js';
import { LOCATOR_FAILURE_CODE } from './types.js';
import { LOCATOR_REGISTRY } from './registry.js';
import { resolveElementLocator, tryResolveElementLocator } from './resolve.js';

const ESC = '\u001b';
const VIEWPORT = viewport({ cols: 80, rows: 24 });
const WIDE_VIEWPORT = viewport({ cols: 120, rows: 40 });

describe('semantic visual locators', { timeout: 90_000 }, () => {
  it('resolves every catalog element at every viewport against production App frames', async () => {
    let resolvedCount = 0;
    const registryKeys = new Set<string>();

    for (const scenario of listVisualScenarios()) {
      const checkpoint = requireCheckpoint(scenario);
      const surface = scenario.surface.kind === 'screen' ? scenario.surface.screen : 'overlay';
      for (const element of scenario.elements) registryKeys.add(`${surface}:${element.id}`);

      for (const frameViewport of scenario.viewports) {
        const handle = await mountGalleryScenario({
          scenario,
          checkpoint,
          viewport: frameViewport,
        });
        try {
          let frame: string;
          try {
            frame = await handle.waitForCheckpoint();
          } catch (error) {
            const message = error instanceof Error ? error.message : 'checkpoint wait failed';
            throw new Error(`${message}\nLast frame:\n${handle.lastFrame() ?? '<empty>'}`);
          }
          const grid = await createFrameGrid(scenario, frameViewport, frame);

          for (const element of scenario.elements) {
            const label = `${scenario.id}/${frameViewport.cols}x${frameViewport.rows}/${element.id}`;
            const result = tryResolveElementLocator({
              scenario,
              checkpoint,
              grid,
              elementId: element.id,
            });
            if (!result.ok) {
              throw new Error(`${label}: ${result.failure.code}: ${result.failure.message}`);
            }

            expect(isCellRectInViewport(result.locator.rect, frameViewport), label).toBe(true);
            expect(isCellRectOnGraphemeBoundaries(grid.cells, result.locator.rect), label).toBe(
              true,
            );
            expect(result.locator.provenance, label).toEqual({
              ...grid.identity.provenance,
              sourceFrameKey: grid.identity.key,
            });
            let crop: CellGrid;
            try {
              crop = createCropCellGrid({ frame: grid, locator: result.locator });
            } catch (error) {
              const message = error instanceof Error ? error.message : 'crop creation failed';
              throw new Error(`${label}: ${message}`);
            }
            expect(crop.rect, label).toEqual(result.locator.rect);
            resolvedCount += 1;
          }
        } finally {
          await handle.unmount();
        }
      }
    }

    expect(Object.keys(LOCATOR_REGISTRY).sort()).toEqual([...registryKeys].sort());
    expect(resolvedCount).toBe(
      listVisualScenarios().reduce(
        (total, scenario) => total + scenario.elements.length * scenario.viewports.length,
        0,
      ),
    );
  }, 120_000);

  it('resolves sidebar, composer, approval panel, and summary hero in bounds with provenance', async () => {
    const home = requireScenario('home-empty');
    const homeGrid = await createFrameGrid(home, VIEWPORT, requireCheckpoint(home).marker);
    const header = resolveElementLocator({
      scenario: home,
      checkpoint: requireCheckpoint(home),
      grid: homeGrid,
      elementId: 'header',
    });
    const workflow = requireScenario('workflow-idle');
    const workflowGrid = await createFrameGrid(
      workflow,
      WIDE_VIEWPORT,
      workflow.checkpoints[0]?.marker ?? '',
    );
    const composer = resolveElementLocator({
      scenario: workflow,
      checkpoint: requireCheckpoint(workflow),
      grid: workflowGrid,
      elementId: 'composer',
    });
    const implementation = requireScenario('workflow-implementation');
    const implementationGrid = await createFrameGrid(
      implementation,
      WIDE_VIEWPORT,
      requireCheckpoint(implementation).marker,
    );
    const sidebar = resolveElementLocator({
      scenario: implementation,
      checkpoint: requireCheckpoint(implementation),
      grid: implementationGrid,
      elementId: 'sidebar',
    });

    const review = requireScenario('workflow-review');
    const reviewCheckpoint = requireCheckpoint(review);
    const reviewGrid = await createFrameGrid(
      review,
      VIEWPORT,
      `${ESC}[10;5H${reviewCheckpoint.marker}`,
    );
    const approval = resolveElementLocator({
      scenario: review,
      checkpoint: reviewCheckpoint,
      grid: reviewGrid,
      elementId: 'approval-panel',
    });

    const summary = requireScenario('summary-success');
    const summaryCheckpoint = requireCheckpoint(summary);
    const summaryGrid = await createFrameGrid(
      summary,
      VIEWPORT,
      `${ESC}[2;4H${summaryCheckpoint.marker}`,
    );
    const hero = resolveElementLocator({
      scenario: summary,
      checkpoint: summaryCheckpoint,
      grid: summaryGrid,
      elementId: 'summary-hero',
    });

    expect(header).toMatchObject({
      kind: 'layout',
      rect: { x: 5, y: 0, width: 70, height: 8 },
    });
    expect(sidebar.kind).toBe('layout');
    expect(sidebar.rect.x).toBe(0);
    expect(composer).toMatchObject({
      kind: 'layout',
      rect: { x: 0, y: 36, width: 120, height: 3 },
    });
    expect(approval).toMatchObject({
      kind: 'marker',
      rect: { x: 0, y: 7, width: 80, height: 5 },
    });
    expect(hero).toMatchObject({
      kind: 'marker',
      rect: { x: 0, y: 0, width: 80, height: 4 },
    });

    for (const locator of [header, sidebar, composer, approval, hero]) {
      expect(isCellRectInViewport(locator.rect, locator.provenance.viewport)).toBe(true);
      expect(locator.provenance).toMatchObject({
        scenarioId:
          locator === header
            ? home.id
            : locator === hero
              ? summary.id
              : locator === approval
                ? review.id
                : locator === sidebar
                  ? implementation.id
                  : workflow.id,
        fixtureVersion: 1,
      });
      expect(locator.provenance.sourceFrameKey).toContain(':frame');
    }
    expect(approval.provenance).toMatchObject({
      scenarioId: review.id,
      scenarioTitle: review.title,
      checkpointId: reviewCheckpoint.id,
      viewport: VIEWPORT,
      sourceFrameKey: reviewGrid.identity.key,
    });
  });

  it('reports invalid names and cross-frame provenance failures', async () => {
    const review = requireScenario('workflow-review');
    const checkpoint = requireCheckpoint(review);
    const duplicateGrid = await createFrameGrid(
      review,
      VIEWPORT,
      `${ESC}[5;3H${checkpoint.marker}${ESC}[10;3H${checkpoint.marker}`,
    );
    expect(
      tryResolveElementLocator({
        scenario: review,
        checkpoint,
        grid: duplicateGrid,
        elementId: '../approval-panel',
      }),
    ).toMatchObject({ ok: false, failure: { code: LOCATOR_FAILURE_CODE.invalidName } });

    const idle = requireScenario('workflow-idle');
    const idleGrid = await createFrameGrid(idle, VIEWPORT, requireCheckpoint(idle).marker);
    const planning = requireScenario('workflow-planning');
    expect(
      tryResolveElementLocator({
        scenario: planning,
        checkpoint: requireCheckpoint(planning),
        grid: idleGrid,
        elementId: 'sidebar',
      }),
    ).toMatchObject({ ok: false, failure: { code: LOCATOR_FAILURE_CODE.crossFrame } });
  });

  it('resolves every recovery spine element at the sidebar breakpoint', async () => {
    let resolvedCases = 0;

    for (const scenarioId of RECOVERY_SCENARIO_IDS) {
      const scenario = requireScenario(scenarioId);
      const checkpoint = requireCheckpoint(scenario);
      const roles = recoveryRoleElements(scenario);

      for (const frameViewport of RECOVERY_BOUNDARY_VIEWPORTS) {
        const handle = await mountGalleryScenario({
          scenario,
          checkpoint,
          viewport: frameViewport,
          profile: recoveryProfileForColumns(frameViewport.cols),
        });
        try {
          const frame = await handle.waitForCheckpoint();
          const grid = await createFrameGrid(scenario, frameViewport, frame);

          for (const element of scenario.elements) {
            const label = `${scenario.id}/${frameViewport.cols}x${frameViewport.rows}/${element.id}`;
            const result = tryResolveElementLocator({
              scenario,
              checkpoint,
              grid,
              elementId: element.id,
            });
            if (!result.ok) {
              throw new Error(`${label}: ${result.failure.code}: ${result.failure.message}`);
            }
            expect(isCellRectInViewport(result.locator.rect, frameViewport), label).toBe(true);
            expect(isCellRectOnGraphemeBoundaries(grid.cells, result.locator.rect), label).toBe(
              true,
            );
            expect(result.locator.provenance.sourceFrameKey, label).toBe(grid.identity.key);
          }

          const input = resolveRole({
            scenario,
            checkpoint,
            grid,
            element: roleElement(roles, 'input'),
          });
          expect(input.rect.width, `${scenario.id} input width`).toBe(frameViewport.cols);

          const sidebarWidth = getWorkflowSidebarWidth({
            cols: frameViewport.cols,
            sidebarVisible: true,
          });
          if (frameViewport.cols > SIDEBAR_BREAKPOINT_COLS) {
            expect(sidebarWidth, `${frameViewport.cols} sidebar width`).toBeGreaterThan(0);
          } else {
            expect(sidebarWidth, `${frameViewport.cols} sidebar width`).toBe(0);
          }

          const body = resolveRole({
            scenario,
            checkpoint,
            grid,
            element: roleElement(roles, 'body'),
          });
          const sidebar = resolveRole({
            scenario,
            checkpoint,
            grid,
            element: roleElement(roles, 'sidebar'),
          });
          const bodyBottom = body.rect.y + body.rect.height - 1;
          const sidebarBottom = sidebar.rect.y + sidebar.rect.height - 1;
          if (frameViewport.cols > SIDEBAR_BREAKPOINT_COLS) {
            expect(sidebar.rect.width, `${scenario.id} visible sidebar`).toBeLessThan(
              frameViewport.cols,
            );
            expect(sidebarBottom, `${scenario.id} sidebar/body bottom`).toBe(bodyBottom);
          } else {
            expect(sidebar.rect.width, `${scenario.id} hidden sidebar`).toBe(frameViewport.cols);
          }

          resolvedCases += 1;
        } finally {
          await handle.unmount();
        }
      }
    }

    expect(resolvedCases).toBe(RECOVERY_SCENARIO_IDS.length * RECOVERY_BOUNDARY_VIEWPORTS.length);
  }, 120_000);
});
