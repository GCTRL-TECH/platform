import { calculateCredits } from '../credits.js';

test('kex_extract charges 25 credits per 1000 chars', () => {
  expect(calculateCredits('kex_extract', 1000)).toBe(25);
  expect(calculateCredits('kex_extract', 2500)).toBe(63);
});

test('kex_ner charges 1 credit per 1000 chars', () => {
  expect(calculateCredits('kex_ner', 1000)).toBe(1);
  expect(calculateCredits('kex_ner', 500)).toBe(1); // ceil
});

test('fuse_merge is flat 10 credits regardless of chars', () => {
  expect(calculateCredits('fuse_merge', 0)).toBe(10);
  expect(calculateCredits('fuse_merge', 99999)).toBe(10);
});

test('talk_query is flat 5 credits', () => {
  expect(calculateCredits('talk_query', 0)).toBe(5);
  expect(calculateCredits('talk_query', 9999)).toBe(5);
});
