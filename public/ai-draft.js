// Per-request consent for opt-in AI drafting. A fresh dialog is built for every
// request and removed afterwards: there is no remembered choice, and nothing is
// sent unless the person ticks the consent box and confirms.
export const AI_FACTS_LIMIT = 2000;
export const AI_DRAFT_LABEL = 'AI draft — check every detail before sending';

export function aiProviderName(config) {
  const name = typeof config?.ai_provider_name === 'string' ? config.ai_provider_name.trim().slice(0, 80) : '';
  return name || 'our AI provider';
}
export function aiDraftingAvailable(config) { return config?.ai_drafting_enabled === true; }

/** The consent wording. `subject` names what is sent, for example the result fields. */
export function aiConsentText(providerName, subject = 'its title, link, snippet, the platform, the request type and anything you type below', noun = 'result') {
  const others = noun === 'result' ? 'Your other results stay in your browser.' : `Your other ${noun}s and your case details stay in your browser.`;
  return `This sends the details of this one ${noun} — ${subject} — to our server and then to ${providerName} to write a draft. We don't store it. ${others}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Resolves with { facts } after explicit consent, or null if cancelled. */
export function requestAiConsent({ providerName, subject, noun = 'result', requestLabel, root = document.body } = {}) {
  return new Promise((resolve) => {
    const id = `ai-consent-${Math.random().toString(36).slice(2)}`;
    const dialog = el('dialog', 'modal');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    const head = el('div', 'modal-head');
    const title = el('h2', '', 'Draft with AI'); title.id = `${id}-title`;
    const close = el('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Cancel AI draft');
    head.append(title, close);
    const content = el('div', 'modal-content');
    const notice = el('div', 'notice');
    notice.append(el('strong', '', 'Before anything is sent'), el('p', '', aiConsentText(providerName, subject, noun)));
    if (requestLabel) notice.append(el('p', 'hint', `Request type: ${requestLabel}`));
    const field = el('div', 'field');
    const label = el('label', '', 'Facts to include ');
    label.append(el('span', 'optional', '(optional)'));
    const facts = el('textarea'); facts.id = `${id}-facts`; facts.maxLength = AI_FACTS_LIMIT; facts.rows = 5;
    label.htmlFor = facts.id;
    const counter = el('p', 'hint', `0 / ${AI_FACTS_LIMIT.toLocaleString()} characters. Only add facts you are comfortable sending. Don't include passwords, ID numbers or intimate details.`);
    counter.id = `${id}-count`; facts.setAttribute('aria-describedby', counter.id);
    field.append(label, facts, counter);
    const consentRow = el('label', 'check spacing-4');
    const consent = el('input'); consent.type = 'checkbox'; consent.checked = false;
    consentRow.append(consent, el('span', '', `I agree to send the details of this one ${noun} to ${providerName} to write this draft.`));
    const actions = el('div', 'modal-actions');
    const send = el('button', 'button primary', `Send and draft with AI`); send.type = 'button'; send.disabled = true;
    const cancel = el('button', 'button ghost', 'Cancel'); cancel.type = 'button';
    actions.append(send, cancel);
    content.append(notice, field, consentRow, actions,
      el('p', 'hint', 'AI drafts can contain mistakes. You review, edit and send every request yourself. The template draft stays available.'));
    dialog.append(head, content);
    let result = null;
    const finish = () => { dialog.close(); };
    facts.addEventListener('input', () => { counter.textContent = `${facts.value.length.toLocaleString()} / ${AI_FACTS_LIMIT.toLocaleString()} characters. Only add facts you are comfortable sending. Don't include passwords, ID numbers or intimate details.`; });
    consent.addEventListener('change', () => { send.disabled = !consent.checked; });
    send.addEventListener('click', () => {
      if (!consent.checked) return;
      result = { facts: facts.value.trim().slice(0, AI_FACTS_LIMIT) };
      finish();
    });
    cancel.addEventListener('click', finish);
    close.addEventListener('click', finish);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    root.append(dialog);
    dialog.showModal();
    facts.focus();
  });
}

