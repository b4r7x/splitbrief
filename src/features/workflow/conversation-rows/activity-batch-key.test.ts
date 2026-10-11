import { describe, expect, it } from 'vitest';
import { activityBatchKey } from './activity-batch-key.js';

describe('activityBatchKey', () => {
  it('uses the first row index and call id as the stable activity batch identity', () => {
    expect(activityBatchKey(7, 'call-1')).toBe('activity-batch:7:call-1');
  });
});
