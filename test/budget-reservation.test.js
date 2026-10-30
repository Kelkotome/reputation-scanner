import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { reserveSerp, today, costOf, overBudget } from '../src/budget.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const connections = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });

// Execute the production statements against real SQLite, with D1's async API.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  connections.push(sqlite);
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const insert = sqlite.prepare('INSERT INTO scans (id, created_at, full_name, name_norm, provider) VALUES (?, 0, ?, ?, ?)');
  insert.run('a', 'Anne Lee', 'anne lee', 'serper');
  insert.run('b', 'Benny Lee', 'benny lee', 'serper');
  return {
    sqlite,
    db: { prepare: sql => ({ bind: (...args) => ({
      run: async () => sqlite.prepare(sql).run(...args),
      first: async () => sqlite.prepare(sql).get(...args) || null,
    }) }) },
  };
}

describe('atomic SERP reservations', () => {
  it('allows only the available slots when multiple scans reserve concurrently', async () => {
    const { db, sqlite } = database();
    const env = { DAILY_SERP_LIMIT: 3, DAILY_USD_LIMIT: 1 };
    const reserved = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveSerp(env, db, i % 2 ? 'a' : 'b')));
    expect(reserved.filter(Boolean)).toHaveLength(3);
    expect(sqlite.prepare('SELECT serp_queries, cost_usd FROM usage_daily WHERE day = ?').get(today()))
      .toMatchObject({ serp_queries: 3, cost_usd: 0.003 });
    expect(sqlite.prepare('SELECT SUM(serp_queries) AS count, SUM(cost_usd) AS cost FROM scans').get())
      .toMatchObject({ count: 3, cost: 0.003 });
  });
  it('checks the projected dollar spend and permits the exact final affordable query', async () => {
    const { db, sqlite } = database();
    const env = { DAILY_SERP_LIMIT: 100, DAILY_USD_LIMIT: 0.3, SERP_COST_PER_1K: 100 };
    expect(await reserveSerp(env, db, 'a')).toBe(true);
    expect(await reserveSerp(env, db, 'a')).toBe(true);
    expect(await reserveSerp(env, db, 'a')).toBe(true);
    expect(await reserveSerp(env, db, 'b')).toBe(false);
    expect(sqlite.prepare('SELECT serp_queries, cost_usd FROM scans WHERE id = ?').get('b'))
      .toMatchObject({ serp_queries: 0, cost_usd: 0 });
    expect(sqlite.prepare('SELECT cost_usd FROM usage_daily').get().cost_usd).toBe(0.3);
  });
  it('honours numeric zero cost and limits', async () => {
    const { db } = database();
    expect(costOf({ SERP_COST_PER_1K: 0, LLM_IN_PER_M: 0, LLM_OUT_PER_M: 0 }, { serp: 100, inTok: 100, outTok: 100 })).toBe(0);
    expect(overBudget({ DAILY_SERP_LIMIT: 0 }, { serp_queries: 0, cost_usd: 0 })).toBe(true);
    expect(overBudget({ DAILY_USD_LIMIT: 0 }, { serp_queries: 0, cost_usd: 0 })).toBe(true);
    expect(await reserveSerp({ DAILY_SERP_LIMIT: 0 }, db, 'a')).toBe(false);
    expect(await reserveSerp({ DAILY_USD_LIMIT: 0 }, db, 'a')).toBe(false);
    expect(await reserveSerp({ DAILY_USD_LIMIT: 0, SERP_COST_PER_1K: 0 }, db, 'a')).toBe(true);
  });
});
