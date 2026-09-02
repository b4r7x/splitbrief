import { afterEach, describe, expect, it } from 'vitest';
import { isCellRectOnGraphemeBoundaries } from './contracts/cells.js';
import { isCellRectInViewport } from './contracts/geometry.js';
import {
  getWorkflowSidebarWidth,
  SIDEBAR_BREAKPOINT_COLS,
} from '../../src/features/workflow/layout/rect.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { BRIEF_RECOVERY_VIEWPORTS } from './catalog.js';
import { teardownVisualFixture } from './fixtures/screen-fixtures.js';
import { mountGalleryScenario } from './gallery/mount.js';
import type { ResolvedElementLocator } from './locators/types.js';
import {
  createFrameGrid,
  RECOVERY_SCENARIO_IDS,
  recoveryProfileForColumns,
  recoveryRoleElements,
  requireCheckpoint,
  requireScenario,
  resolveRole,
  roleLocator,
  textInRect,
  type RecoveryLocatorRole,
} from './recovery-locators.js';

const EXPECTED_STATUS_BY_SCENARIO: Readonly<Record<string, RegExp>> = {
  'workflow-brief-recovery-zero-task-blocked': /CONTRACT BLOCKED/i,
  'workflow-brief-recovery-storage-blocked': /CONTRACT BLOCKED/i,
  'workflow-brief-recovery-task-blocked': /CONTRACT BLOCKED/i,
  'workflow-brief-recovery-retrying-queued': /RETRYING/i,
  'workflow-brief-recovery-unresolved': /RETRY UNRESOLVED/i,
  'workflow-brief-recovery-ready': /CONTRACT READY/i,
  'workflow-brief-recovery-provider-failed': /CONTRACT BLOCKED/i,
  'workflow-brief-recovery-budget-blocked': /CONTRACT BLOCKED/i,
};

const EXPECTED_CAUSE_BY_SCENARIO: Readonly<Record<string, RegExp>> = {
  'workflow-brief-recovery-zero-task-blocked': /QUALITY ISSUE T000/,
  'workflow-brief-recovery-storage-blocked': /BECAUSE STORAGE/,
  'workflow-brief-recovery-task-blocked': /QUALITY ISSUE T901/,
  'workflow-brief-recovery-retrying-queued': /THE CURRENT RECOVERY/,
  'workflow-brief-recovery-unresolved': /UNRESOLVED RETRY/,
  'workflow-brief-recovery-ready': /CONTRACT CHECK PASSED/,
  'workflow-brief-recovery-provider-failed': /PROVIDER REFUSAL/,
  'workflow-brief-recovery-budget-blocked': /BUDGET REFUSAL/,
};

const RECOVERY_CASES = RECOVERY_SCENARIO_IDS.flatMap((scenarioId) =>
  BRIEF_RECOVERY_VIEWPORTS.map((frameViewport) => ({ scenarioId, frameViewport })),
);

describe('Brief recovery semantic shots', { timeout: 180_000 }, () => {
  afterEach(() => {
    teardownVisualFixture();
  });

  it.each(BRIEF_RECOVERY_VIEWPORTS)(
    'shows the sidebar only above the breakpoint at $cols cols',
    (frameViewport) => {
      const sidebarWidth = getWorkflowSidebarWidth({
        cols: frameViewport.cols,
        sidebarVisible: true,
      });
      expect(sidebarWidth > 0).toBe(frameViewport.cols > SIDEBAR_BREAKPOINT_COLS);
    },
  );

  it.each(RECOVERY_CASES)(
    'keeps the recovery evidence spine actionable: $scenarioId at $frameViewport.cols cols',
    async ({ scenarioId, frameViewport }) => {
      const scenario = requireScenario(scenarioId);
      const checkpoint = requireCheckpoint(scenario);
      const roles = recoveryRoleElements(scenario);
      const status = EXPECTED_STATUS_BY_SCENARIO[scenarioId];
      if (status === undefined) throw new Error(`Missing status expectation for ${scenarioId}`);
      const cause = EXPECTED_CAUSE_BY_SCENARIO[scenarioId];
      if (cause === undefined) throw new Error(`Missing cause expectation for ${scenarioId}`);

      const handle = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: frameViewport,
        profile: recoveryProfileForColumns(frameViewport.cols),
      });
      try {
        const frame = await handle.waitForCheckpoint();
        const visible = stripAnsiStyles(frame);
        const grid = await createFrameGrid(scenario, frameViewport, frame);

        expect(visible, 'status').toMatch(status);
        expect(visible, 'cause label').toContain('BECAUSE');
        expect(visible, 'consequence label').toContain('SO');
        expect(visible, 'action label').toContain('NOW');

        if (scenarioId === 'workflow-brief-recovery-zero-task-blocked') {
          expect(visible, 'zero-task diagnosis').toContain('T000');
        }

        const locators = new Map<RecoveryLocatorRole, ResolvedElementLocator>();
        for (const [role, element] of roles) {
          const locator = resolveRole({ scenario, checkpoint, grid, element });
          expect(isCellRectInViewport(locator.rect, frameViewport), role).toBe(true);
          expect(
            isCellRectOnGraphemeBoundaries(grid.cells, locator.rect),
            `${role} graphemes`,
          ).toBe(true);
          locators.set(role, locator);
        }

        const input = roleLocator(locators, 'input');
        expect(input.rect.width, 'input width').toBe(frameViewport.cols);

        const statusText = textInRect(grid, roleLocator(locators, 'status').rect);
        expect(statusText, 'status row').toMatch(status);

        const causeText = textInRect(grid, roleLocator(locators, 'cause').rect);
        expect(causeText, 'cause row').toMatch(cause);

        const actionText = textInRect(grid, roleLocator(locators, 'actions').rect).toLowerCase();
        expect(actionText, 'action text').toMatch(/retry|edit|reject|approve|import|resolve|wait/);

        const body = roleLocator(locators, 'body');
        const sidebar = roleLocator(locators, 'sidebar');
        if (frameViewport.cols > SIDEBAR_BREAKPOINT_COLS) {
          expect(sidebar.rect.width, 'sidebar').toBeLessThan(frameViewport.cols);
          const bodyBottom = body.rect.y + body.rect.height - 1;
          const sidebarBottom = sidebar.rect.y + sidebar.rect.height - 1;
          expect(sidebarBottom, 'sidebar/body bottom').toBe(bodyBottom);
        } else {
          expect(sidebar.rect.width, 'no sidebar').toBe(frameViewport.cols);
        }
      } finally {
        await handle.unmount();
      }
    },
  );
});
