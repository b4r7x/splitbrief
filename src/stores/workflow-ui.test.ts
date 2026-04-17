import { describe, it, expect, beforeEach } from 'vitest';
import { workflowUIStore } from './workflow-ui.js';

describe('workflowUIStore', () => {
  beforeEach(() => workflowUIStore.reset());

  describe('initial state', () => {
    it('has sidebarVisible as false', () => {
      expect(workflowUIStore.get()).toEqual({ sidebarVisible: false });
    });
  });

  describe('toggleSidebar', () => {
    it('flips sidebarVisible from false to true', () => {
      expect(workflowUIStore.get().sidebarVisible).toBe(false);
      workflowUIStore.toggleSidebar();
      expect(workflowUIStore.get().sidebarVisible).toBe(true);
    });

    it('flips sidebarVisible from true to false', () => {
      workflowUIStore.reset({ sidebarVisible: true });
      workflowUIStore.toggleSidebar();
      expect(workflowUIStore.get().sidebarVisible).toBe(false);
    });
  });

  describe('reset', () => {
    it('restores initial state', () => {
      workflowUIStore.reset({ sidebarVisible: true });
      expect(workflowUIStore.get().sidebarVisible).toBe(true);
      workflowUIStore.reset();
      expect(workflowUIStore.get().sidebarVisible).toBe(false);
    });
  });
});
