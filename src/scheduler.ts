import { ModelError } from './types.js';

export function abortError(signal: AbortSignal): ModelError {
  return signal.reason instanceof ModelError ? signal.reason : new ModelError('CANCELLED', 'Request cancelled');
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

interface Waiter { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }

/** FIFO admission. Cancelled work leaves the queue immediately; rate limits count starts. */
export class Scheduler {
  active = 0;
  private queue: Waiter[] = [];
  private starts: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private concurrency: number, private maxQueue: number, private requestsPerMinute: number) {}
  get queued(): number { return this.queue.length; }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    this.prune();
    if (!this.queue.length && this.active < this.concurrency && this.rateReady()) return Promise.resolve(this.enter());
    if (this.queue.length >= this.maxQueue) return Promise.reject(new ModelError('QUEUE_FULL', 'Request queue is full'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        this.queue = this.queue.filter(item => item !== waiter);
        signal.removeEventListener('abort', waiter.abort);
        reject(abortError(signal));
        this.drain();
      } };
      this.queue.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.drain();
    });
  }
  private prune(): void { const before = Date.now() - 60_000; this.starts = this.starts.filter(time => time > before); }
  private rateReady(): boolean { return !this.requestsPerMinute || this.starts.length < this.requestsPerMinute; }
  private enter(): () => void {
    this.active++;
    if (this.requestsPerMinute) this.starts.push(Date.now());
    let released = false;
    return () => { if (!released) { released = true; this.active--; this.drain(); } };
  }
  private drain(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.prune();
    while (this.queue.length && this.active < this.concurrency && this.rateReady()) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) waiter.reject(abortError(waiter.signal));
      else waiter.resolve(this.enter());
    }
    if (this.queue.length && this.active < this.concurrency && !this.rateReady()) {
      this.timer = setTimeout(() => this.drain(), Math.max(1, this.starts[0]! + 60_000 - Date.now()));
    }
  }
}
