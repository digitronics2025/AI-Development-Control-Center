import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, Settings, ToolExecution } from '@acc/shared';
import { keys } from './keys.js';
import { CacheSync } from './sync.js';

const execution = (capability: string) => ({ id: 'e1', taskId: null, capability }) as unknown as ToolExecution;

describe('CacheSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('refreshes the usage views after a media tool call, which may have reserved or settled paid spend', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const sync = new CacheSync(qc);
    sync.apply({ type: 'toolExecution', execution: execution('fs.read') } as ServerMessage);
    vi.advanceTimersByTime(1_500);
    expect(invalidate).not.toHaveBeenCalled();
    sync.apply({ type: 'toolExecution', execution: execution('media.image.generate') } as ServerMessage);
    vi.advanceTimersByTime(1_500);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['usage'] });
  });

  it('refreshes the media spend view after a settings change, which carries the paid-generation switch and per-task budget', () => {
    const qc = new QueryClient();
    const media = keys.usage('media-30');
    qc.setQueryData(media, { allowPaidGeneration: false, taskBudgetNanos: 0 });
    const settings = { media: { allowPaidGeneration: true, taskBudgetUsd: 2 } } as unknown as Settings;
    new CacheSync(qc).apply({ type: 'settings', settings } as ServerMessage);
    expect(qc.getQueryData(keys.settings)).toBe(settings);
    // Without a refetch the panel kept the old values until the next minute's poll.
    expect(qc.getQueryState(media)?.isInvalidated).toBe(true);
  });
});
