export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createConcurrencyLimiter(concurrency: number): ConcurrencyLimiter {
  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const limit = Math.max(1, requested);
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      next();
    }
  };
  const start = <T>(
    task: () => Promise<T>,
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void,
  ): void => {
    active += 1;
    Promise.resolve().then(task).then(resolve, reject).finally(release);
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const begin = (): void => start(task, resolve, reject);
        if (active < limit) {
          begin();
        } else {
          waiting.push(begin);
        }
      });
    },
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }
  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const limit = Math.max(1, Math.min(items.length, requested));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      results[index] = await run(item, index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
