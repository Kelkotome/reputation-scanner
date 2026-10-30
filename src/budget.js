// Daily spend guard, per-scan cost accounting and SERP result cache (all in D1).

export function today() { return new Date().toISOString().slice(0, 10); }

export function costOf(env, { serp = 0, inTok = 0, outTok = 0 }) {
  return serp * Number(env.SERP_COST_PER_1K ?? 1) / 1000
    + inTok * Number(env.LLM_IN_PER_M ?? 1) / 1e6
    + outTok * Number(env.LLM_OUT_PER_M ?? 5) / 1e6;
}

/** Estimated AI drafting cost from token usage. Defaults match Claude Sonnet 5
 * list prices (USD 2 / 10 per million input / output tokens). The shipped
 * configs set gpt-5-mini prices instead; set AI_INPUT_USD_PER_M and AI_OUTPUT_USD_PER_M when using another model. */
export function aiCostOf(env, { inTok = 0, outTok = 0 }) {
  const rate = (value, fallback) => {
    const n = Number(value === undefined || value === null || value === '' ? fallback : value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return Math.round((inTok * rate(env.AI_INPUT_USD_PER_M, 2) / 1e6 + outTok * rate(env.AI_OUTPUT_USD_PER_M, 10) / 1e6) * 1e12) / 1e12;
}

export async function getUsage(db, day = today()) {
  return (await db.prepare('SELECT * FROM usage_daily WHERE day = ?').bind(day).first())
    || { day, serp_queries: 0, in_tokens: 0, out_tokens: 0, cost_usd: 0 };
}

/** Pure check so it can be unit-tested. */
export function overBudget(env, usage) {
  return usage.serp_queries >= Number(env.DAILY_SERP_LIMIT ?? 3000)
    || usage.cost_usd >= Number(env.DAILY_USD_LIMIT ?? 15);
}

/** Reserve one external SERP request before making it. The daily limit check and
 * increment are one SQL statement, so concurrent scans cannot overspend the cap.
 * The caller holds the scan lease; reservations are charged even on provider
 * errors because an external provider may still charge for the attempted call.
 */
export async function reserveSerp(env, db, scanId) {
  const day = today();
  const cost = costOf(env, { serp: 1 });
  await db.prepare('INSERT INTO usage_daily (day) VALUES (?) ON CONFLICT(day) DO NOTHING').bind(day).run();
  const reserved = await db.prepare(`UPDATE usage_daily
    SET serp_queries = serp_queries + 1, cost_usd = ROUND(cost_usd + ?, 12)
    WHERE day = ? AND serp_queries + 1 <= ? AND ROUND(cost_usd + ?, 12) <= ?
    RETURNING day`)
    .bind(cost, day, Number(env.DAILY_SERP_LIMIT ?? 3000), cost, Number(env.DAILY_USD_LIMIT ?? 15)).first();
  if (!reserved) return false;
  await db.prepare('UPDATE scans SET serp_queries = serp_queries + 1, cost_usd = ROUND(cost_usd + ?, 12) WHERE id = ?')
    .bind(cost, scanId).run();
  return true;
}

export async function checkBudget(env, db) {
  const u = await getUsage(db);
  return { ok: !overBudget(env, u), usage: u };
}

export async function recordUsage(env, db, scanId, { serp = 0, inTok = 0, outTok = 0 }) {
  if (!serp && !inTok && !outTok) return;
  const cost = costOf(env, { serp, inTok, outTok });
  const day = today();
  await db.batch([
    db.prepare(`INSERT INTO usage_daily (day, serp_queries, in_tokens, out_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET serp_queries = serp_queries + excluded.serp_queries,
        in_tokens = in_tokens + excluded.in_tokens, out_tokens = out_tokens + excluded.out_tokens,
        cost_usd = cost_usd + excluded.cost_usd`).bind(day, serp, Math.round(inTok), outTok, cost),
    db.prepare(`UPDATE scans SET serp_queries = serp_queries + ?, in_tokens = in_tokens + ?,
        out_tokens = out_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?`).bind(serp, Math.round(inTok), outTok, cost, scanId),
  ]);
}

export function cacheKey(provider, q) { return `${provider}|${q.trim().toLowerCase()}`; }

export async function cacheGet(env, db, provider, q) {
  const days = Number(env.SERP_CACHE_DAYS || 7);
  const row = await db.prepare('SELECT json, created_at FROM serp_cache WHERE key = ?').bind(cacheKey(provider, q)).first();
  if (!row || Date.now() - row.created_at > days * 864e5) return null;
  try { return JSON.parse(row.json); } catch { return null; }
}

export async function cachePut(db, provider, q, data) {
  await db.prepare('INSERT OR REPLACE INTO serp_cache (key, json, created_at) VALUES (?, ?, ?)')
    .bind(cacheKey(provider, q), JSON.stringify(data), Date.now()).run();
}
