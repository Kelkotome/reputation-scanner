import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { expandQueries } from '../src/expand.js';
import worker from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
function expansionFetch(queries) {
  return vi.fn().mockResolvedValue(Response.json({ content: [{ type: 'tool_use', input: { queries } }] }));
}

describe('review regression checks', () => {
  it('rejects AI expansion about longer same-name substrings but retains the exact handle', async () => {
    const fetchImpl = expansionFetch([
      { q: 'Joanne Lee complaint', priority: 2 },
      { q: 'Anne Leeway scam', priority: 1 },
      { q: 'annelee review', priority: 3 },
      { q: 'Anne Lee court', priority: 1 },
    ]);
    const result = await expandQueries({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, { full_name: 'Anne Lee' }, ['anne lee'], fetchImpl);
    expect(result.queries.map(x => x.q)).toEqual(['annelee review', 'Anne Lee court']);
  });
  it('enforces the expansion limit even if an AI response exceeds its schema cap', async () => {
    const queries = Array.from({ length: 35 }, (_, i) => ({ q: `Anne Lee complaint ${i}`, priority: 2 }));
    const result = await expandQueries({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, { full_name: 'Anne Lee' }, ['anne lee'], expansionFetch(queries));
    expect(result.queries).toHaveLength(20);
    expect(result.queries.map(x => x.q)).toEqual(queries.slice(0, 20).map(x => x.q));
  });
  it('preserves a new minor declaration when reusing an earlier adult scan', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
      const prepare = (sql, args = []) => ({
        bind: (...values) => prepare(sql, values),
        first: async () => sqlite.prepare(sql).get(...args) || null,
        all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
        run: async () => { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
      });
      const env = { DB: { prepare, batch: async statements => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec('COMMIT'); return results;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      } }, IP_SALT: 'regression-test', SERP_PROVIDER: 'mock' };
      const create = isMinor => worker.fetch(new Request('https://scanner.example/api/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'Anne Lee', attestation: true, is_minor: isMinor, harm_types: ['scam_fraud'] }),
      }), env);
      const original = await (await create(false)).json();
      const reused = await (await create(true)).json();
      expect(reused).toMatchObject({ id: original.id, reused: true, show_help_first: true });
      expect(sqlite.prepare('SELECT is_minor FROM scans WHERE id = ?').get(original.id).is_minor).toBe(1);
      expect((await (await create(false)).json()).show_help_first).toBe(true);
    } finally { sqlite.close(); }
  });
});
