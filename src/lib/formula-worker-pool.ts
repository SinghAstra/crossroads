import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../config/index.ts';
import type { FormulaWorkerRequest, RawFormulaResponse } from './formula-runner-types.ts';

const workerPath = fileURLToPath(new URL('./formula-worker.cjs', import.meta.url));

interface PendingRequest {
  payload: FormulaWorkerRequest;
  timeoutMs: number;
  resolve: (response: RawFormulaResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface WorkerSlot {
  process: ChildProcess;
  request: PendingRequest | null;
  dead: boolean;
}

class FormulaWorkerPool {
  private readonly size: number;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingRequest[] = [];
  private started = false;
  private closing = false;
  constructor(size: number) {
    this.size = Math.max(1, size);
  }
  run(executable: string, data: Record<string, unknown>, timeoutMs: number): Promise<RawFormulaResponse> {
    if (this.closing) {
      return Promise.reject(new Error('Formula worker pool is closed'));
    }
    this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({
        payload: { evalString: executable, libraries: [], EXTERNAL_VAR: { CODE: data } },
        timeoutMs,
        resolve,
        reject,
        timer: null,
      });
      this.dispatch();
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    const queued = this.queue.splice(0);
    queued.forEach((pending) => {
      pending.reject(new Error('Formula worker pool is closed'));
    });
    const exits = this.slots.map((slot) => this.closeSlot(slot));
    await Promise.all(exits);
    this.slots.length = 0;
  }
  private start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    for (let index = 0; index < this.size; index += 1) {
      this.addSlot();
    }
  }
  private addSlot(): void {
    const worker = fork(workerPath, [], {
      execArgv: ['--max-old-space-size=10'],
      serialization: 'advanced',
    });
    worker.unref();
    const slot: WorkerSlot = { process: worker, request: null, dead: false };
    worker.on('message', (message: unknown) => {
      this.handleMessage(slot, message as RawFormulaResponse);
    });
    worker.on('exit', (code, signal) => {
      this.handleExit(slot, code, signal);
    });
    worker.on('error', (error) => {
      this.handleError(slot, error);
    });
    this.slots.push(slot);
  }
  private closeSlot(slot: WorkerSlot): Promise<void> {
    if (slot.dead || slot.process.exitCode !== null || slot.process.signalCode !== null) {
      return Promise.resolve();
    }
    slot.process.ref();
    return new Promise((resolve) => {
      slot.process.once('exit', () => resolve());
      slot.process.kill('SIGKILL');
    });
  }
  private handleMessage(slot: WorkerSlot, response: RawFormulaResponse): void {
    const pending = slot.request;
    if (!pending) {
      return;
    }
    slot.request = null;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.resolve(response);
    this.dispatch();
  }
  private handleExit(slot: WorkerSlot, code: number | null, signal: NodeJS.Signals | null): void {
    if (slot.dead) {
      return;
    }
    slot.dead = true;
    const pending = slot.request;
    slot.request = null;
    if (pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.resolve({
        status: 0,
        error: `Formula worker exited unexpectedly (code: ${code}, signal: ${signal})`,
      });
    }
    const index = this.slots.indexOf(slot);
    if (index >= 0) {
      this.slots.splice(index, 1);
    }
    if (!this.closing) {
      this.addSlot();
      this.dispatch();
    }
  }
  private handleError(slot: WorkerSlot, error: Error): void {
    this.failSlot(slot, error);
  }
  private dispatch(): void {
    if (this.closing) {
      return;
    }
    for (const slot of this.slots) {
      if (slot.request || slot.dead) {
        continue;
      }
      const pending = this.queue.shift();
      if (!pending) {
        return;
      }
      this.assign(slot, pending);
    }
  }
  private assign(slot: WorkerSlot, pending: PendingRequest): void {
    slot.request = pending;
    pending.timer = setTimeout(() => {
      this.handleTimeout(slot);
    }, pending.timeoutMs);
    try {
      slot.process.send(pending.payload, (error) => {
        if (!error || slot.request !== pending) {
          return;
        }
        this.failSlot(slot, error);
      });
    } catch (error) {
      this.failSlot(slot, error instanceof Error ? error : new Error('Formula worker send failed'));
    }
  }
  private failSlot(slot: WorkerSlot, error: Error): void {
    const pending = slot.request;
    slot.request = null;
    if (pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.resolve({ status: 0, error: error.message });
    }
    slot.dead = true;
    const index = this.slots.indexOf(slot);
    if (index >= 0) {
      this.slots.splice(index, 1);
    }
    slot.process.kill('SIGKILL');
    if (!this.closing) {
      this.addSlot();
      this.dispatch();
    }
  }
  private handleTimeout(slot: WorkerSlot): void {
    const pending = slot.request;
    if (!pending) {
      return;
    }
    this.failSlot(slot, new Error('Timed out'));
  }
}

export const formulaWorkerPool = new FormulaWorkerPool(config.formula.formulaConcurrency);

export function closeFormulaWorkers(): Promise<void> {
  return formulaWorkerPool.close();
}
