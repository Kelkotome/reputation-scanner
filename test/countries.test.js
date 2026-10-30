import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COUNTRIES, COUNTRY_ALIASES } from '../src/countries.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const select = html.match(/<select\b[^>]*\bid="country"[^>]*>([\s\S]*?)<\/select>/);
const decodeText = (value) => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');

describe('supported country choices', () => {
  it('has one immutable entry per canonical provider code in alphabetical order', () => {
    expect(COUNTRIES).toHaveLength(242);
    expect(new Set(COUNTRIES.map(({ code }) => code)).size).toBe(COUNTRIES.length);
    expect(COUNTRIES.every(({ code }) => /^[a-z]{2}$/.test(code))).toBe(true);
    expect(Object.isFrozen(COUNTRIES)).toBe(true);
    expect(COUNTRIES.every(Object.isFrozen)).toBe(true);
    const alphabetical = [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    expect(COUNTRIES).toEqual(alphabetical);
  });

  it('uses current display names and a single supported United Kingdom code', () => {
    const names = Object.fromEntries(COUNTRIES.map(({ code, name }) => [code, name]));
    expect(names).toMatchObject({ cz: 'Czechia', sz: 'Eswatini', mk: 'North Macedonia', tr: 'Türkiye', uk: 'United Kingdom', sg: 'Singapore' });
    expect(names).not.toHaveProperty('gb');
    expect(names).not.toHaveProperty('an');
    expect(COUNTRIES.filter(({ name }) => name === 'United Kingdom')).toHaveLength(1);
  });

  it('keeps original provider names as aliases to supported canonical choices', () => {
    expect(Object.isFrozen(COUNTRY_ALIASES)).toBe(true);
    expect(COUNTRY_ALIASES).toMatchObject({ 'Czech Republic': 'cz', Swaziland: 'sz', Turkiye: 'tr', 'United Kingdom': 'uk', 'Viet Nam': 'vn' });
    expect(COUNTRY_ALIASES).not.toHaveProperty('Netherlands Antilles');
    const codes = new Set(COUNTRIES.map(({ code }) => code));
    expect(Object.values(COUNTRY_ALIASES).every((code) => codes.has(code))).toBe(true);
  });

  it('renders exactly the canonical list in the native optional dropdown with no country preferred', () => {
    expect(select).not.toBeNull();
    expect(select[0]).toMatch(/\bname="country_code"/);
    expect(select[0]).toMatch(/\bautocomplete="country"/);
    expect(select[0]).toMatch(/\baria-describedby="country-hint"/);
    expect(select[0].split('>')[0]).not.toMatch(/\brequired\b/);
    const options = [...select[1].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attributes, text]) => ({
      code: attributes.match(/\bvalue="([^"]*)"/)[1],
      name: decodeText(text),
      selected: /\bselected\b/.test(attributes),
    }));
    expect(options[0]).toEqual({ code: '', name: 'No country preference', selected: true });
    expect(options.slice(1)).toEqual(COUNTRIES.map((country) => ({ ...country, selected: false })));
    expect(options.filter(({ selected }) => selected)).toHaveLength(1);
    expect(html).toContain('Country or region <span class="optional">(optional)</span>');
    // The static hint is safe before provider capabilities are loaded. Live
    // country support is provider-specific (covered by browser-scans tests).
    expect(html).toContain('id="country-hint" class="hint">Helps distinguish people or businesses with similar names.');
  });
});
