import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_MS, PONG_DEADLINE_MS, RealtimeClient, type RealtimeRouting } from './realtime';

/** A socket the test drives by hand: nothing happens unless the test says so. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  pings() {
    return this.sent.filter((s) => s === '{"type":"ping"}').length;
  }
}

const latest = () => FakeSocket.all[FakeSocket.all.length - 1]!;
let visibility: 'visible' | 'hidden';
let win: EventTarget;
let doc: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  visibility = 'visible';
  win = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval });
  doc = new EventTarget();
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const onMessage = vi.fn();
  const onOpen = vi.fn();
  const c = new RealtimeClient('ws://x/ws', onMessage, onOpen);
  c.start();
  latest().open();
  return { c, onMessage, onOpen };
}

describe('realtime heartbeat', () => {
  it('pings a visible page and keeps the socket while pongs come back', () => {
    const { c } = client();
    const socket = latest();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(socket.pings()).toBe(1);
    socket.receive({ type: 'pong' });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(socket.pings()).toBe(2);
    socket.receive({ type: 'pong' });
    vi.advanceTimersByTime(PONG_DEADLINE_MS);
    expect(FakeSocket.all).toHaveLength(1);
    expect(c.getState().status).toBe('open');
    c.stop();
  });

  it('never hands a pong to the page', () => {
    const { c, onMessage } = client();
    latest().receive({ type: 'pong' });
    expect(onMessage).not.toHaveBeenCalled();
    c.stop();
  });

  it('replaces a socket that stopped answering, then refetches on the new one', () => {
    const { c, onOpen } = client();
    const dead = latest();
    vi.advanceTimersByTime(HEARTBEAT_MS + PONG_DEADLINE_MS);
    expect(dead.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    expect(c.getState().status).toBe('connecting');
    latest().open();
    expect(onOpen).toHaveBeenLastCalledWith(true);
    c.stop();
  });

  it('counts any message as an answer', () => {
    const { c } = client();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    latest().receive({ type: 'task.deleted', taskId: 't1' });
    vi.advanceTimersByTime(PONG_DEADLINE_MS);
    expect(FakeSocket.all).toHaveLength(1);
    c.stop();
  });

  it('stays quiet while the page is hidden', () => {
    const { c } = client();
    visibility = 'hidden';
    vi.advanceTimersByTime(HEARTBEAT_MS * 4);
    expect(latest().pings()).toBe(0);
    c.stop();
  });

  it('probes at once when the page becomes visible again', () => {
    const { c } = client();
    visibility = 'hidden';
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    visibility = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(latest().pings()).toBe(1);
    vi.advanceTimersByTime(PONG_DEADLINE_MS);
    expect(FakeSocket.all).toHaveLength(2);
    c.stop();
  });

  it('reconnects at once on return when the socket is already down, instead of waiting out the backoff', () => {
    const { c } = client();
    const first = latest();
    first.readyState = FakeSocket.CLOSED;
    first.onclose?.();
    expect(c.getState().status).toBe('closed');
    win.dispatchEvent(new Event('pageshow'));
    expect(FakeSocket.all).toHaveLength(2);
    c.stop();
  });

  it('clears every timer and listener on stop()', () => {
    const { c } = client();
    c.stop();
    vi.advanceTimersByTime(HEARTBEAT_MS * 4);
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pings undecorated in cloud mode, so the hub answers it itself, and reports failed connects', () => {
    const routing: RealtimeRouting = { accept: () => true, decorate: (m) => ({ ...m, nodeId: 'node_1' }), onCloudMessage: vi.fn(), onLinkFailure: vi.fn() };
    const c = new RealtimeClient('ws://x/ws', vi.fn(), vi.fn(), routing);
    c.start();
    latest().open();
    c.probe();
    expect(latest().sent).toEqual(['{"type":"ping"}']);
    latest().onclose?.();
    expect(routing.onLinkFailure).toHaveBeenCalledWith(1);
    c.stop();
  });
});
