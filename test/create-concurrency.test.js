import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import worker from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const connections = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
const responseDelay = () => new Promise(resolve => setTimeout(resolve, 10));

function harness(limit) {
  const sqlite = new DatabaseSync(':memory:');
  connections.push(sqlite);
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql, args = []) => {
    const execute = () => {
      const result = sqlite.prepare(sql).run(...args);
      return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    };
    return {
      bind: (...values) => prepare(sql, values), execute,
      first: async () => {
        const row = sqlite.prepare(sql).get(...args) || null;
        // Return the snapshot later, as with a remote D1 request. Concurrent
        // creates can all observe the initial missing row before any insert.
        await responseDelay(); return row;
      },
      run: async () => { const result = execute(); await responseDelay(); return result; },
    };
  };
  const env = {
    IP_SALT: 'concurrency-test-only', SERP_PROVIDER: 'mock', SCANS_PER_IP_PER_DAY: limit,
    DB: { prepare, batch: async statements => {
      // Real D1 executes the statements atomically, then returns the response.
      sqlite.exec('BEGIN');
      let results;
      try { results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      await responseDelay(); return results;
    } },
  };
  const create = async (fullName, isMinor = false) => {
    const response = await worker.fetch(new Request('https://scanner.example/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: fullName, is_minor: isMinor, attestation: true, harm_types: [] }),
    }), env);
    return { status: response.status, data: await response.json() };
  };
  return { sqlite, create };
}

describe('concurrent scan creation', () => {
  it('reuses one scan and one allowance slot even when every initial lookup misses', async () => {
    const { sqlite, create } = harness(1);
    const responses = await Promise.all(Array.from({ length: 12 }, () => create('Anne Lee')));
    expect(responses.filter(x => x.status === 201)).toHaveLength(1);
    expect(responses.filter(x => x.status === 200 && x.data.reused)).toHaveLength(11);
    expect(new Set(responses.map(x => x.data.id)).size).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(1);
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(1);
  });
  it('does not exceed the allowance when distinct names compete for the final slots', async () => {
    const { sqlite, create } = harness(3);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => create(`Person Number ${i}`)));
    expect(responses.filter(x => x.status === 201)).toHaveLength(3);
    expect(responses.filter(x => x.status === 429)).toHaveLength(9);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(3);
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(3);
  });
  it('retains the safer minor declaration from a concurrent reuse request', async () => {
    const { sqlite, create } = harness(1);
    const responses = await Promise.all([create('Anne Lee'), create('Anne Lee', true)]);
    expect(responses.every(x => x.status === 200 || x.status === 201)).toBe(true);
    expect(new Set(responses.map(x => x.data.id)).size).toBe(1);
    expect(responses[1].data.show_help_first).toBe(true);
    expect(sqlite.prepare('SELECT is_minor FROM scans').get().is_minor).toBe(1);
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(1);
  });
});
