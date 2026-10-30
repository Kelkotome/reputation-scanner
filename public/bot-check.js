// The challenge receives only a public site key and a fixed action. Never pass
// names, search terms, URLs, local record identifiers or custom cData here.
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const failure = (code, message, status = 403) => Object.assign(new Error(message), { code, status });

export function createBotCheck({ document = globalThis.document, window = globalThis.window, load } = {}) {
  let scriptPromise, active = false;
  function loadTurnstile() {
    if (load) return load();
    if (window.turnstile?.render) return Promise.resolve(window.turnstile);
    if (!scriptPromise) scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT; script.async = true; script.defer = true; script.referrerPolicy = 'no-referrer';
      const timer = setTimeout(() => stop(), 15000);
      const stop = () => { clearTimeout(timer); script.remove(); reject(failure('bot_check_unavailable', 'The security check could not load. Check your connection and retry.', 503)); };
      script.onerror = stop;
      script.onload = () => {
        if (!window.turnstile?.render) { stop(); return; }
        const ready = () => { clearTimeout(timer); resolve(window.turnstile); };
        if (typeof window.turnstile.ready === 'function') window.turnstile.ready(ready); else ready();
      };
      document.head.append(script);
    }).catch(error => { scriptPromise = null; throw error; });
    return scriptPromise;
  }
  return async ({ action, sitekey }) => {
    if (!['scan_start', 'assistance', 'ai_draft'].includes(action) || typeof sitekey !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(sitekey)) {
      throw failure('bot_check_unavailable', 'The security check is not configured.', 503);
    }
    if (active) throw failure('bot_check_required', 'Finish or cancel the security check already open.');
    active = true;
    const element = (tag, className, text) => {
      const node = document.createElement(tag); if (className) node.className = className;
      if (text) node.textContent = text; return node;
    };
    const previousFocus = document.activeElement;
    const dialog = element('dialog', 'modal'); dialog.setAttribute('aria-labelledby', 'security-check-title');
    const header = element('div', 'modal-head'), title = element('h2', '', 'Security check'); title.id = 'security-check-title';
    header.append(title);
    const content = element('div', 'modal-content');
    content.append(element('p', '', 'Complete this check to continue. Cloudflare processes your IP address and browser signals to help prevent automated abuse. We do not pass names, queries or report details to this widget.'));
    const status = element('p', 'inline-status', 'Loading the security check…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const container = element('div', 'spacing-4'), actions = element('div', 'modal-actions');
    const retry = element('button', 'button primary', 'Retry security check'), cancel = element('button', 'button secondary', 'Cancel');
    retry.type = 'button'; retry.hidden = true; cancel.type = 'button'; actions.append(retry, cancel);
    content.append(status, container, actions); dialog.append(header, content); document.body.append(dialog);
    return new Promise((resolve, reject) => {
      let sdk, widget, settled = false, generation = 0;
      const removeWidget = () => { if (widget !== undefined) { try { sdk?.remove(widget); } catch {} widget = undefined; } container.replaceChildren(); };
      const finish = (error, token) => {
        if (settled) return; settled = true; generation++; clearTimeout(timeout); removeWidget();
        dialog.close(); dialog.remove(); active = false; previousFocus?.focus?.();
        if (error) reject(error); else resolve(token);
      };
      const timeout = setTimeout(() => finish(failure('bot_check_expired', 'The security check expired. Please retry with a fresh check.')), 300000);
      const showFailure = message => { generation++; removeWidget(); status.textContent = message; retry.hidden = false; retry.disabled = false; retry.focus(); };
      async function start() {
        const current = ++generation; removeWidget(); retry.hidden = true; status.textContent = 'Complete the security check below.';
        try {
          sdk = await loadTurnstile();
          if (settled || current !== generation) return;
          widget = sdk.render(container, { sitekey, action, theme: 'auto', size: 'flexible', appearance: 'always',
            retry: 'never', 'refresh-expired': 'manual', 'refresh-timeout': 'manual', 'response-field': false,
            callback: token => {
              if (settled || current !== generation) return;
              if (typeof token !== 'string' || !token || token.length > 2048) { showFailure('The security check did not finish. Please retry.'); return; }
              finish(null, token);
            },
            'error-callback': () => { if (!settled && current === generation) showFailure('The security check could not finish. Check your connection and retry.'); },
            'expired-callback': () => { if (!settled && current === generation) showFailure('The security check expired. Please retry.'); },
            'timeout-callback': () => { if (!settled && current === generation) showFailure('The security check timed out. Please retry.'); },
            'unsupported-callback': () => { if (!settled && current === generation) showFailure('This browser could not run the security check. Try an updated browser or retry.'); },
          });
          if (settled) removeWidget();
        } catch { if (!settled && current === generation) showFailure('The security check could not load. Check your connection and retry.'); }
      }
      const cancelCheck = () => finish(failure('bot_check_cancelled', 'The security check was cancelled. You can retry when you are ready.'));
      cancel.addEventListener('click', cancelCheck);
      dialog.addEventListener('cancel', event => { event.preventDefault(); cancelCheck(); });
      retry.addEventListener('click', start);
      try { dialog.showModal(); cancel.focus(); start(); }
      catch { finish(failure('bot_check_unavailable', 'This browser could not open the security check. Try an updated browser.', 503)); }
    });
  };
}
