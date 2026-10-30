import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const file = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const jsonc = path => JSON.parse(file(path).split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n'));
const APP_PAGES = ['index', 'contact', 'help', 'report', 'takedowns', 'dashboard', 'email-connected'];

describe('launch configuration', () => {
  it('defaults both Worker configurations to a twenty-result allowance', () => {
    const local = jsonc('wrangler.jsonc'), production = jsonc('deploy/cloudflare/wrangler.production.example.jsonc');
    expect(local.vars.SHOW_LIMIT).toBe('20');
    expect(production.vars.SHOW_LIMIT).toBe('20');
    expect(local.workers_dev).toBe(false);
    expect(production.workers_dev).toBe(false);
    expect(production.name).toBe('reputation-scanner');
    expect(production.vars.CLOUD_AI_ENABLED).toBe('false');
  });

  it('declares the assistance email binding with a destination matching ASSISTANCE_TO', () => {
    const production = jsonc('deploy/cloudflare/wrangler.production.example.jsonc');
    expect(production.send_email).toEqual([{ name: 'ASSISTANCE_MAIL', destination_address: production.vars.ASSISTANCE_TO }]);
    expect(production.vars.ASSISTANCE_TO).toBe('hello@123reputationmanagement.org');
    expect(production.vars.ASSISTANCE_FROM).toBe('scanner@notify.123reputationmanagement.org');
  });

  it('sends site-wide security headers and keeps private pages out of link following', () => {
    const headers = file('public/_headers');
    const global = headers.split(/\n\s*\n/).find(block => /^\/\*$/m.test(block));
    for (const header of ['Strict-Transport-Security: max-age=31536000',
      'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
      'Cross-Origin-Opener-Policy: same-origin-allow-popups', 'X-Robots-Tag: noindex, follow']) expect(global).toContain(header);
    for (const block of headers.split(/\n\s*\n/).filter(block => block.includes('noindex, nofollow'))) expect(block).toContain('! X-Robots-Tag');
    expect(file('public/robots.txt')).toBe('User-agent: *\nAllow: /\n');
  });
});

describe('public pages', () => {
  it.each(APP_PAGES)('%s.html links the privacy notice, terms, help resources and the generic operator line', page => {
    const html = file(`public/${page}.html`);
    expect(html).toContain('href="/privacy.html"');
    expect(html).toContain('href="/terms.html"');
    expect(html).toContain('https://123reputationmanagement.org/free-name-scanner/');
    expect(html).toContain('https://123reputationmanagement.org/help-resources/');
    expect(html).toContain('The Reputation Scanner is free, open-source software. It doesn’t provide legal advice or guarantee any removal.');
    expect(html).not.toMatch(/Sovereign|UEN 202502243M|Anson Road/);
    expect(html).toMatch(/<title>[^<]*Reputation Scanner[^<]*<\/title>/);
    expect(html).not.toContain('Operator sign in');
    expect(html).not.toContain('href="/admin"');
  });

  it('ships generic, operator-neutral privacy and terms pages', () => {
    for (const page of ['privacy', 'terms']) {
      const html = file(`public/${page}.html`);
      expect(html).toMatch(/<html/i);
      expect(html).not.toMatch(/Sovereign|UEN 202502243M|Anson Road|LAWYER|\[Effective date\]/);
    }
  });

  it('names the Reputation Scanner and carries Open Graph metadata on the landing page', () => {
    const html = file('public/index.html');
    expect(html).toContain('<meta property="og:title" content="Reputation Scanner');
    expect(html).toContain('<meta property="og:description" content="');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).not.toMatch(/Free Reputation Tools|free reputation toolkit|>Reputation scan</);
    expect(html).toContain('See up to 20 prioritised mentions');
    expect(html).toContain('only its hostname is sent to our server and to public DNS and domain-registration services');
    expect(html).toContain('emailed to the 123 Reputation Management team');
    expect(html).not.toContain('hosting-contact lookups are not fetched');
  });

  it('removes stale report copy and keeps the locked-results contact flow at twenty', () => {
    const html = file('public/report.html');
    expect(html).not.toContain('Severity is an automated priority score');
    expect(html).toContain('Your first 20 priority links are available above.');
    expect(html).toContain('Contact us to uncover more');
    expect(file('public/app.js')).not.toContain('#operator-link');
  });
});
