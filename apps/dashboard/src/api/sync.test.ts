import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, ToolExecution } from '@acc/shared';
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
});
