// Bounded parallel map: run `fn` over every item with at most `limit` in flight, results in input
// order. Every call site here is fanning out provider requests (judge calls, agent invocations),
// where unbounded Promise.all is the difference between a fast run and a 429 storm.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
