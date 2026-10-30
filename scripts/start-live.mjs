// Verify the dedicated live provider before presenting a working local app.
// Never substitute demo results, print credentials, or log search result bodies.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { preflightLiveSearch } from '../src/searxng-preflight.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = 8788;
const checkOnly = process.argv.includes('--check');
const childEnvironment = { ...process.env, WRANGLER_SEND_METRICS: 'false' };

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: childEnvironment, stdio: 'inherit', windowsHide: true });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const cleanup = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); };
    child.once('error', () => { cleanup(); reject(new Error('Could not start the local runtime. Run npm ci and try again.')); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0 || signal) resolve();
      else reject(new Error(`Local runtime exited with code ${code}.`));
    });
  });
}

async function checkPort() {
  await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', () => reject(new Error(`Port ${port} is in use. Stop the existing local preview before starting live mode.`)));
    listener.listen(port, '127.0.0.1', () => listener.close(resolve));
  });
}

try {
  let env;
  try { env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8')); }
  catch { throw new Error('Create the private .env from .env.example and configure the dedicated SearXNG connection first.'); }
  if (env.SERP_PROVIDER !== 'searxng') throw new Error('Live mode requires SERP_PROVIDER=searxng in .env.');
  if ((env.RATE_LIMIT_SECRET || '').length < 32) throw new Error('Configure a private RATE_LIMIT_SECRET of at least 32 characters in .env.');
  if (!checkOnly) await checkPort();
  console.log('Checking SearXNG engines and any configured Google backup with neutral queries (no personal search).');
  let verification;
  try { verification = await preflightLiveSearch(env); }
  catch { throw new Error('Live SearXNG is unavailable or misconfigured. Start the dedicated SSH tunnel, or configure an authenticated HTTPS endpoint in .env. No demo fallback was used.'); }
  const checks = verification.primary.checks;
  if (!verification.passed) throw new Error(`Live search verification failed for: ${checks.filter(check => !check.verified).map(check => check.engine).join(', ')}. Degraded startup requires at least one responding SearXNG engine and a verified SerpApi Google backup. Verify the private provider settings before enabling live mode.`);
  for (const check of checks) {
    if (check.verified) console.log(`PASS: ${check.engine} returned ${check.results} text results in a neutral probe (${check.attempts} ${check.attempts === 1 ? 'attempt' : 'attempts'}).`);
    else console.warn(`WARN: ${check.engine} did not verify (${check.reason}; ${check.attempts} neutral ${check.attempts === 1 ? 'attempt' : 'attempts'}).`);
  }
  if (verification.backup.verified) console.log(`PASS: SerpApi Google backup returned ${verification.backup.results} text results in one neutral probe.`);
  else if (verification.backup.enabled) console.warn(`WARN: Google backup did not verify (${verification.backup.reason}). All selected SearXNG primary engines verified.`);
  if (verification.degraded) console.warn('WARN: Starting with degraded SearXNG coverage and a verified SerpApi Google backup. Unverified primary engines are not counted as responding.');
  console.log('Neutral probes confirm limited connectivity, not exhaustive coverage. SafeSearch off was requested; upstream support is engine-dependent.');
  const engines = checks.filter(check => check.verified).map(check => check.engine);
  console.log(`Responding general engines: ${engines.join(', ')}.`);
  if (engines.length === 1 && engines[0] === 'google cse') console.log('SearXNG primary coverage limit: Google CSE uses a subset of the Google web index. This check does not establish parity with Google.com.');
  if (!checkOnly) {
    await run('scripts/build-browser.mjs');
    const wrangler = 'node_modules/wrangler/bin/wrangler.js';
    await run(wrangler, ['d1', 'execute', 'name_scanner', '--local', '--persist-to', '.wrangler/live-state', '--file=schema.sql']);
    console.log(`Starting live search at http://127.0.0.1:${port}. Keep the dedicated search connection running.`);
    await run(wrangler, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', '.wrangler/live-state', '--env-file', '.env',
      '--var', 'SERP_PROVIDER:searxng', '--var', 'ALLOW_SEARCH_RELAY:true', '--var', 'CLOUD_AI_ENABLED:false',
      '--var', 'LOCAL_DEVELOPMENT:true', '--var', 'TURNSTILE_ENABLED:false']);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
