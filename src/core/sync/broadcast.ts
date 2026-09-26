import type { Transport, TransportStatus } from './protocol';

/** Same-device sync between tabs/windows via BroadcastChannel. */
export class BroadcastTransport implements Transport {
  readonly name = 'tabs';
  status: TransportStatus = 'connecting';
  private ch: BroadcastChannel | null;
  private msgFns = new Set<(d: Uint8Array) => void>();
  private statusFns = new Set<(s: TransportStatus) => void>();

  constructor(channel: string) {
    this.ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channel) : null;
    if (this.ch) {
      this.ch.onmessage = (e) => {
        const d = e.data;
        if (d instanceof Uint8Array) for (const fn of this.msgFns) fn(d);
        else if (d instanceof ArrayBuffer) for (const fn of this.msgFns) fn(new Uint8Array(d));
      };
    }
    queueMicrotask(() => this.setStatus(this.ch ? 'open' : 'closed'));
  }

  private setStatus(s: TransportStatus) {
    this.status = s;
    for (const fn of this.statusFns) fn(s);
  }

  send(data: Uint8Array) {
    this.ch?.postMessage(data);
  }

  onMessage(fn: (d: Uint8Array) => void) {
    this.msgFns.add(fn);
    return () => this.msgFns.delete(fn);
  }

  onStatus(fn: (s: TransportStatus) => void) {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  }

  close() {
    this.ch?.close();
    this.ch = null;
    this.setStatus('closed');
  }
}

/** In-memory transport pair, used by tests and for simulating devices. */
export function memoryTransportPair(nameA = 'mem', nameB = 'mem'): [Transport, Transport] {
  const make = (name: string) => {
    const msgFns = new Set<(d: Uint8Array) => void>();
    const statusFns = new Set<(s: TransportStatus) => void>();
    const t: Transport & { deliver(d: Uint8Array): void; open(): void; status: TransportStatus } = {
      name,
      status: 'connecting',
      send: () => {},
      onMessage(fn) {
        msgFns.add(fn);
        return () => msgFns.delete(fn);
      },
      onStatus(fn) {
        statusFns.add(fn);
        return () => statusFns.delete(fn);
      },
      close() {
        t.status = 'closed';
        statusFns.forEach((f) => f('closed'));
      },
      deliver(d) {
        msgFns.forEach((f) => f(d));
      },
      open() {
        t.status = 'open';
        statusFns.forEach((f) => f('open'));
      },
    };
    return t;
  };
  const a = make(nameA);
  const b = make(nameB);
  a.send = (d) => setTimeout(() => b.status === 'open' && b.deliver(d), 0);
  b.send = (d) => setTimeout(() => a.status === 'open' && a.deliver(d), 0);
  setTimeout(() => {
    a.open();
    b.open();
  }, 0);
  return [a, b];
}
