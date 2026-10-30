import { describe, it, expect, vi } from 'vitest';
import { costOf, overBudget, cacheKey, cacheGet, recordUsage } from '../src/budget.js';

describe('budget and cached search costs', () => {
  it('prices SERP queries and both token directions with defaults and configured rates', () => {
    expect(costOf({}, { serp: 60, inTok: 10000, outTok: 2000 })).toBeCloseTo(0.08);
    expect(costOf({ SERP_COST_PER_1K: '2', LLM_IN_PER_M: '3', LLM_OUT_PER_M: '15' }, { serp: 1000, inTok: 1e6, outTok: 1e6 })).toBe(20);
    expect(costOf({}, {})).toBe(0);
  });
  it('stops at either configured daily boundary', () => {
    expect(overBudget({}, { serp_queries: 2999, cost_usd: 14.99 })).toBe(false);
    expect(overBudget({}, { serp_queries: 3000, cost_usd: 0 })).toBe(true);
    expect(overBudget({}, { serp_queries: 0, cost_usd: 15 })).toBe(true);
    expect(overBudget({ DAILY_SERP_LIMIT: '5', DAILY_USD_LIMIT: '0.25' }, { serp_queries: 1, cost_usd: 0.25 })).toBe(true);
  });
  it('isolates cache entries by provider and ignores expired or invalid records', async () => {
    expect(cacheKey('mock', ' Anne Lee ')).toBe('mock|anne lee');
    const first = vi.fn();
    const db = { prepare: () => ({ bind: () => ({ first }) }) };
    first.mockResolvedValueOnce({ created_at: Date.now(), json: '{"results":[]}' });
    expect(await cacheGet({}, db, 'mock', 'Anne Lee')).toEqual({ results: [] });
    first.mockResolvedValueOnce({ created_at: Date.now() - 8 * 864e5, json: '{}' });
    expect(await cacheGet({}, db, 'mock', 'Anne Lee')).toBeNull();
    first.mockResolvedValueOnce({ created_at: Date.now(), json: 'invalid' });
    expect(await cacheGet({}, db, 'mock', 'Anne Lee')).toBeNull();
  });
  it('records the same usage against the day and scan in one batch', async () => {
    const db = { prepare: sql => ({ bind: (...args) => ({ sql, args }) }), batch: vi.fn() };
    await recordUsage({}, db, 'scan-a', { serp: 1, inTok: 10, outTok: 5 });
    const [day, scan] = db.batch.mock.calls[0][0];
    expect(day.args.slice(1, 4)).toEqual([1, 10, 5]);
    expect(day.args[4]).toBeCloseTo(0.001035, 12);
    expect(scan.args).toEqual([1, 10, 5, day.args[4], 'scan-a']);
  });
});
