import { UsageQueue } from '../usageQueue.js';

test('enqueue accumulates records', () => {
  const q = new UsageQueue();
  q.enqueue({ action: 'kex_extract', chars_processed: 1000, credits_spent: 25 });
  q.enqueue({ action: 'fuse_merge', chars_processed: 0, credits_spent: 10 });
  expect(q.size()).toBe(2);
});

test('flush returns and clears queue', () => {
  const q = new UsageQueue();
  q.enqueue({ action: 'kex_extract', chars_processed: 1000, credits_spent: 25 });
  const flushed = q.flush();
  expect(flushed).toHaveLength(1);
  expect(q.size()).toBe(0);
});
