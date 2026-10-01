import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { stopChildAndWait } from './child-exit.js';

const child = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
afterEach(() => vi.useRealTimers());

it('clears the shutdown fallback on exit, so the test worker can terminate', async () => {
  vi.useFakeTimers();
  const fixture = child();
  const stopped = stopChildAndWait(fixture, () => fixture.emit('exit', 0));
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.listenerCount('exit')).toBe(0);
});

it('still bounds shutdown when an owned child never reports exit', async () => {
  vi.useFakeTimers();
  const fixture = child();
  const stop = vi.fn();
  const stopped = stopChildAndWait(fixture, stop);
  await vi.advanceTimersByTimeAsync(10_000);
  await stopped;
  expect(stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.listenerCount('exit')).toBe(0);
});

it('clears the timer and listener when stopping the child throws', async () => {
  vi.useFakeTimers();
  const fixture = child();
  await expect(stopChildAndWait(fixture, () => { throw new Error('stop failed'); })).rejects.toThrow('stop failed');
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.listenerCount('exit')).toBe(0);
});
