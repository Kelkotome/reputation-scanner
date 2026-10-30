import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBotCheck } from '../public/bot-check.js';

function dom() {
  const nodes = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; nodes.push(this); }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    fire(name) { this.events[name]?.({ preventDefault() {} }); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
  }
  const document = { createElement: tag => new Element(tag), body: new Element('body'), head: new Element('head'), activeElement: { focus: vi.fn() } };
  return { document, nodes, find: text => [...nodes].reverse().find(node => node.textContent === text) };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('on-demand security check', () => {
  it('loads only the official script on demand and sends only the public key and fixed action', async () => {
    const ui = dom(), window = {}, sdk = { render: vi.fn(() => 'widget-1'), remove: vi.fn() };
    const check = createBotCheck({ document: ui.document, window });
    expect(ui.document.head.children).toHaveLength(0);
    const pending = check({ action: 'scan_start', sitekey: 'public-key', private_name: 'Never forwarded' });
    const script = ui.document.head.children[0];
    expect(script.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    expect(script.referrerPolicy).toBe('no-referrer');
    window.turnstile = sdk; script.onload(); await flush();
    const options = sdk.render.mock.calls[0][1];
    expect(options).toMatchObject({ action: 'scan_start', sitekey: 'public-key', 'response-field': false, retry: 'never' });
    expect(options).not.toHaveProperty('cData'); expect(JSON.stringify(options)).not.toContain('Never forwarded');
    expect(ui.document.body.children[0].attributes).toMatchObject({ 'aria-labelledby': 'security-check-title' });
    options.callback('single-use-token');
    expect(await pending).toBe('single-use-token');
    expect(sdk.remove).toHaveBeenCalledWith('widget-1'); expect(ui.document.body.children).toHaveLength(0);
    expect(ui.document.activeElement.focus).toHaveBeenCalledOnce();
  });

  it('clears failed widgets, exposes manual retry and ignores callbacks from an old attempt', async () => {
    const ui = dom(), sdk = { render: vi.fn().mockReturnValueOnce('old').mockReturnValueOnce('fresh'), remove: vi.fn() };
    const check = createBotCheck({ document: ui.document, window: {}, load: async () => sdk });
    const pending = check({ action: 'assistance', sitekey: 'public-key' }); await flush();
    const old = sdk.render.mock.calls[0][1]; old['error-callback']('private diagnostic');
    const retry = ui.find('Retry security check'); expect(retry.hidden).toBe(false);
    expect(sdk.remove).toHaveBeenCalledWith('old');
    expect(ui.nodes.some(node => node.textContent?.includes('private diagnostic'))).toBe(false);
    retry.fire('click'); await flush(); old.callback('stale-token');
    expect(ui.document.body.children).toHaveLength(1);
    sdk.render.mock.calls[1][1].callback('fresh-token'); expect(await pending).toBe('fresh-token');
  });

  it('allows cancellation after expiry and never accepts an expired callback', async () => {
    const ui = dom(), sdk = { render: vi.fn(() => 'widget'), remove: vi.fn() };
    const check = createBotCheck({ document: ui.document, window: {}, load: async () => sdk });
    const pending = check({ action: 'scan_start', sitekey: 'public-key' }); await flush();
    const options = sdk.render.mock.calls[0][1]; options['expired-callback'](); options.callback('expired-token');
    expect(ui.find('Retry security check').hidden).toBe(false);
    ui.find('Cancel').fire('click');
    await expect(pending).rejects.toMatchObject({ code: 'bot_check_cancelled' });
    expect(ui.document.body.children).toHaveLength(0);
  });

  it('expires an abandoned check after five minutes without storing a token', async () => {
    vi.useFakeTimers();
    const ui = dom(), sdk = { render: vi.fn(() => 'widget'), remove: vi.fn() };
    const check = createBotCheck({ document: ui.document, window: {}, load: async () => sdk });
    const pending = check({ action: 'scan_start', sitekey: 'public-key' });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'bot_check_expired' });
    await vi.advanceTimersByTimeAsync(300000); await rejection;
    expect(ui.document.body.children).toHaveLength(0); expect(sdk.remove).toHaveBeenCalledWith('widget');
  });
});
