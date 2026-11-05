// Isolated, explicit network boundary for optional account connection and sending.
// No scan, hit ID, search query, or draft is shared until Send is confirmed.
import { recipientRoute } from '/recipient-route.js?v=20261101-send';
import { senderProvider, senderMatches, manualDraft } from '/sender-workflow.js?v=20260930-sender';
export function setupEmailSending({ onAccepted, beforeSend = async () => {}, context = () => ({}), fields = {}, canSchedule = () => true, canSend = () => true }) {
  const $ = s => document.querySelector(fields[s] || s);
  const box = document.createElement('section');
  box.className = 'panel spacing-4';
  box.hidden = true;
  box.innerHTML = `<h3>Send from your email account</h3>
    <p class="hint">Use the email entered above as your sending address. Connect that same mailbox to send through the platform. We request sending permission and account identity, not inbox access.</p>
    <div class="field"><label for="sender-provider">Who hosts this mailbox?</label><select id="sender-provider"><option value="choose">Choose for a business or other address</option><option value="gmail">Gmail / Google Workspace</option><option value="outlook">Outlook / Microsoft 365</option><option value="other">Other provider / my email app</option></select><p class="hint" id="sender-guidance" role="status"></p></div>
    <label><input id="email-offline" type="checkbox"> Keep my email connected for up to 30 days to allow automatic follow-ups</label><p class="hint">Otherwise connections last up to one hour. Reconnecting or disconnecting cancels existing queued follow-ups.</p>
    <div class="modal-actions"><button type="button" class="button secondary" id="connect-gmail">Connect Gmail</button><button type="button" class="button secondary" id="connect-outlook">Connect Outlook</button><button type="button" class="button ghost" id="disconnect-email" hidden>Disconnect</button></div>
    <p id="connected-account" role="status" class="hint">Checking email connection…</p>
    <button type="button" class="button ghost" id="use-connected-email" hidden>Use this address as my contact email</button>
    <details><summary>How your email connection is handled</summary><p class="hint">Only emails you approve are sent. With automatic follow-ups, encrypted credentials and the approved follow-up are stored for up to 30 days. The follow-up body is erased after submission or cancellation. Disconnect cancels queued follow-ups and removes stored access. You can also revoke permission in your provider account.</p></details>`;
  $('#draft-email').closest('.field').after(box);
  const recipient = document.createElement('div');
  recipient.className = 'field';
  recipient.innerHTML = `<label for="send-recipient">Send to</label><input id="send-recipient" type="email" maxlength="254" autocomplete="off" placeholder="Selected automatically when a verified email is available"><p id="recipient-routing" class="hint"></p><a id="recipient-route-link" class="button secondary" target="_blank" rel="noopener noreferrer" hidden></a><button id="send-platform" type="button" class="button primary" disabled hidden>Review & send from connected account</button><p id="send-status" class="inline-status" role="status"></p>`;
  // After the review tick box, so the send buttons come once the draft is checked.
  $('#draft-accurate').closest('label').after(recipient);
  const manual = document.createElement('section');
  manual.innerHTML = `<div class="modal-actions"><button type="button" class="button secondary" id="manual-email-open">Open in my email app</button><button type="button" class="button ghost compact" id="manual-email-download">Download draft (.eml)</button></div>`;
  recipient.append(manual);
  const choices = document.createElement('div'); choices.className = 'field'; choices.hidden = true;
  choices.innerHTML = '<label for="infrastructure-destination">Available escalation destinations</label><select id="infrastructure-destination"></select>';
  recipient.prepend(choices);
  let contacts = [];
  $('#infrastructure-destination').addEventListener('change', () => {
    setChannel(contacts[Number($('#infrastructure-destination').value)] || null);
    choices.hidden = false; $('#draft-accurate').checked = false; gate();
  });
  const review = document.createElement('dialog');
  review.className = 'modal'; review.setAttribute('aria-labelledby', 'send-review-title');
  review.innerHTML = `<div class="modal-head"><h2 id="send-review-title">Confirm your email</h2></div><div class="modal-content"><p id="send-summary"></p><h3 id="send-review-subject"></h3><pre id="send-review-body" class="email-review-body"></pre><p>This sends the email now. Provider acceptance does not confirm delivery or removal.</p><div class="modal-actions"><button id="confirm-email-send" type="button" class="button primary">Send email now</button><button id="cancel-email-send" type="button" class="button secondary">Back to editing</button></div><p id="send-review-status" role="status"></p></div>`;
  document.body.append(review);
  const followupFields = document.createElement('section');
  followupFields.innerHTML = `<label><input type="checkbox" id="schedule-followup"> Send one follow-up 14 days after the first email is accepted</label>
    <p class="hint">Review both messages before sending. We cannot detect replies: record a reply or close the request in <a href="/dashboard.html">your dashboard</a> to cancel. The hourly hosted scheduler sends at or after the due time; local previews do not run it automatically.</p>
    <div id="followup-editor" hidden><div class="field"><label for="followup-subject">Follow-up subject</label><input id="followup-subject" maxlength="180"></div><div class="field"><label for="followup-body">Follow-up message</label><textarea id="followup-body" rows="9" maxlength="20000"></textarea></div></div>`;
  $('#send-review-body').after(followupFields);
  $('#schedule-followup').addEventListener('change', () => { $('#followup-editor').hidden = !$('#schedule-followup').checked; });
  let account = null, busy = false, snapshot = null, statusLoading = false, route = recipientRoute(null);
  let previousSender = null;
  function setChannel(channel, helpUrl) {
    choices.hidden = true;
    route = recipientRoute(channel);
    $('#send-recipient').value = route.email;
    $('#send-recipient').disabled = route.kind === 'form' || route.kind === 'manual';
    $('#send-recipient').hidden = $('label[for="send-recipient"]').hidden = route.kind === 'form' || route.kind === 'manual';
    $('#recipient-routing').textContent = route.label;
    const link = $('#recipient-route-link');
    link.hidden = route.kind === 'email' || (!route.url && route.kind !== 'unknown');
    manual.hidden = route.kind === 'form' || route.kind === 'manual';
    link.href = route.url || helpUrl || document.querySelector('#expert-link')?.href || '/contact.html';
    link.textContent = route.kind === 'form' ? 'Open the reporting form ↗' : 'Ask us to find where to report';
    gate();
  }
  async function request(path, data) {
    const response = await fetch(`/api/email/${path}`, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(25000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Email action could not be completed.');
    return result;
  }
  function gate() {
    const entered = $('#draft-email').value.trim();
    if (entered !== previousSender) { previousSender = entered; $('#sender-provider').value = senderProvider(entered); }
    if ($('#sender-provider').value === 'choose' && senderMatches(entered,account?.email)) $('#sender-provider').value=account.provider;
    const provider = $('#sender-provider').value;
    $('#connect-gmail').hidden = provider !== 'gmail'; $('#connect-outlook').hidden = provider !== 'outlook';
    const matches = senderMatches(entered,account?.email);
    $('#sender-guidance').textContent = account && !matches ? `The connected mailbox (${account.email}) does not match the entered sender. Connect the correct mailbox, or explicitly use the connected address and review your draft again.`
      : provider === 'choose' ? 'For a custom business address, choose Google Workspace or Microsoft 365 only if that service hosts your mailbox. Otherwise use your email app below. No password is needed here.'
      : provider === 'other' ? 'This provider is supported through a manual draft. Platform sending and automatic follow-ups are not available for this connection type.'
      : `Connect ${entered || 'your address'} using ${provider === 'gmail' ? 'Google' : 'Microsoft'}. Choose that exact account during sign-in.`;
    $('#send-platform').disabled = busy || !canSend() || route.kind === 'form' || route.kind === 'manual' || !account || account.expires_at <= Date.now() || $('#draft-editor').hidden || !$('#draft-accurate').checked
      || !matches || provider !== account?.provider || !entered || !$('#draft-email').checkValidity() || !$('#send-recipient').value.trim() || !$('#send-recipient').checkValidity();
    for (const id of ['manual-email-open','manual-email-download']) $(`#${id}`).disabled = busy || !canSend() || ['form','manual'].includes(route.kind) || $('#draft-editor').hidden || !$('#draft-accurate').checked || !entered || !$('#draft-email').checkValidity() || !$('#send-recipient').value.trim() || !$('#send-recipient').checkValidity();
  }
  $('#sender-provider').addEventListener('change',gate);
  $('#draft-email').addEventListener('input',()=>{ $('#draft-accurate').checked=false;gate(); });
  for (const action of ['open','download']) $(`#manual-email-${action}`).addEventListener('click',()=>{
    gate(); if ($(`#manual-email-${action}`).disabled) return;
    try {
      const draft = manualDraft({from:$('#draft-email').value.trim(),to:$('#send-recipient').value.trim(),subject:$('#draft-subject').value,body:$('#draft-body').value});
      if (action === 'open') {
        if (draft.mailto.length>1800) throw new Error('This message is too long for a reliable email-app link. Download the email draft instead, or copy the message into your mailbox.');
        location.href=draft.mailto;
      } else {
        const url=URL.createObjectURL(new Blob([draft.eml],{type:'message/rfc822'})); const a=document.createElement('a');a.href=url;a.download='removal-request.eml';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }
      $('#send-status').textContent=`Draft prepared only. In your email app, select ${$('#draft-email').value.trim()}, review and send. Then use “Mark sent” here. No automatic follow-up has been scheduled.`;
    } catch(error) { $('#send-status').textContent=error.message; }
  });
  async function refresh() {
    if (statusLoading || busy) return;
    statusLoading = true;
    try {
      const result = await request('status'); account = result.account;
      for (const provider of ['gmail', 'outlook']) {
        $(`#connect-${provider}`).disabled = !result.providers[provider];
        $(`#connect-${provider}`).title = result.providers[provider] ? '' : 'Awaiting provider setup by the app owner';
      }
      $('#connected-account').textContent = account ? `Connected: ${account.email} (${account.provider === 'gmail' ? 'Gmail' : 'Outlook'}). Expires ${new Date(account.expires_at).toLocaleString()}. ${account.local_preview ? 'Automatic follow-ups are unavailable in this local preview; use the hosted app.' : account.followups_enabled ? 'Automatic follow-ups available.' : 'Reconnect with the 30-day option to enable automatic follow-ups.'}`
        : Object.values(result.providers).some(Boolean) ? 'Connect an account when you are ready to send.' : 'Direct sending is awaiting provider setup. You can still preview drafts or open them in your email app.';
      // Hide account sending entirely until a provider is configured.
      const sendingAvailable = Boolean(account) || Object.values(result.providers).some(Boolean);
      box.hidden = !sendingAvailable; $('#send-platform').hidden = !sendingAvailable;
      $('#disconnect-email').hidden = !account;
      $('#use-connected-email').hidden = !account;
    } catch { account = null; $('#connected-account').textContent = 'Email connection could not be checked. Your draft is still available.'; }
    finally { statusLoading = false; gate(); }
  }
  for (const provider of ['gmail', 'outlook']) $(`#connect-${provider}`).addEventListener('click', async () => {
    if (!$('#draft-email').value.trim() || !$('#draft-email').checkValidity()) { $('#connected-account').textContent='Enter a valid sending email first.'; return; }
    // Open synchronously so provider authorization is not blocked as a popup.
    const popup = window.open('about:blank', '_blank');
    if (!popup) { $('#connected-account').textContent = 'Allow popups for this app, then try connecting again.'; return; }
    popup.opener = null;
    try { const result = await request('connect', { provider, offline: $('#email-offline').checked, expected_email:$('#draft-email').value.trim() }); popup.location.href = result.url; }
    catch (error) { popup.close(); $('#connected-account').textContent = error.message; }
  });
  $('#disconnect-email').addEventListener('click', async () => {
    try { await request('disconnect', {}); account = null; await refresh(); }
    catch (error) { $('#connected-account').textContent = error.message; }
  });
  $('#use-connected-email').addEventListener('click', () => {
    if (!account) return;
    $('#draft-email').value = account.email;
    $('#draft-email').dispatchEvent(new Event('input', { bubbles: true }));
    $('#draft-accurate').checked = false; gate();
  });
  for (const id of ['draft-email', 'draft-accurate', 'send-recipient', 'draft-subject', 'draft-body']) {
    $(`#${id}`).addEventListener('input', gate); $(`#${id}`).addEventListener('change', gate);
  }
  new MutationObserver(gate).observe($('#draft-editor'), { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { if ($('#draft-modal').open) { $('#send-status').textContent = ''; refresh(); } }).observe($('#draft-modal'), { attributes: true, attributeFilter: ['open'] });
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  $('#send-platform').addEventListener('click', async () => {
    gate(); if ($('#send-platform').disabled) return;
    if (/\[[^\]\r\n]{2,300}\]/.test($('#draft-subject').value + $('#draft-body').value)) { $('#send-status').textContent = 'Replace or remove every bracketed placeholder before sending.'; return; }
    if (!$('#draft-subject').value.trim() || !$('#draft-body').value.trim()) { $('#send-status').textContent = 'Add a subject and message first.'; return; }
    snapshot = { from: $('#draft-email').value.trim(), to: $('#send-recipient').value.trim(), subject: $('#draft-subject').value, body: $('#draft-body').value };
    $('#send-summary').textContent = `From: ${account.email} → To: ${snapshot.to}`;
    $('#send-review-subject').textContent = snapshot.subject;
    $('#send-review-body').textContent = snapshot.body;
    $('#schedule-followup').disabled = !account.followups_enabled || !canSchedule();
    $('#schedule-followup').checked = Boolean(account.followups_enabled && canSchedule());
    $('#followup-editor').hidden = !$('#schedule-followup').checked;
    $('#followup-subject').value = `Follow-up: ${snapshot.subject}`.slice(0, 180);
    $('#followup-body').value = `Hello,\n\nI am following up on my removal request sent approximately 14 days ago.\n\nOriginal subject: ${snapshot.subject}\n\nPlease refer to my original email for the exact URLs and supporting details. Please confirm receipt, provide a reference number and let me know the action taken or any further information you need. My requested outcome remains removal of the reported content.\n\nThank you.`;
    $('#send-review-status').textContent = '';
    $('#confirm-email-send').disabled = false;
    review.showModal();
  });
  $('#cancel-email-send').addEventListener('click', () => { if (!busy) review.close(); });
  review.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('#confirm-email-send').addEventListener('click', async () => {
    if (busy || !snapshot || !account) return;
    if ($('#schedule-followup').checked) {
      snapshot.followup = { subject: $('#followup-subject').value.trim(), body: $('#followup-body').value.trim() };
      if (!snapshot.followup.subject || !snapshot.followup.body || /\[[^\]\r\n]{2,300}\]/.test(snapshot.followup.subject + snapshot.followup.body)) { $('#send-review-status').textContent = 'Complete the follow-up and replace any bracketed placeholders.'; return; }
    } else delete snapshot.followup;
    if (new TextEncoder().encode(JSON.stringify({...snapshot,request_id:'0'.repeat(36),confirmed:true})).length > 32768) { $('#send-review-status').textContent = 'The combined messages exceed the 32 KB sending limit. Shorten them before sending.'; return; }
    busy = true; gate(); $('#confirm-email-send').disabled = true; $('#cancel-email-send').disabled = true;
    $('#send-review-status').textContent = 'Submitting your email…';
    try {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)))), b => b.toString(16).padStart(2, '0')).join('');
      const storageKey = `rep-email-send:${hash}`;
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      const receipt = saved || { request_id: crypto.randomUUID(), status: 'pending', ...context(), to: snapshot.to, subject: snapshot.subject, ...(snapshot.followup ? {followup:{status:'pending'}} : {}) };
      // Persist BEFORE sharing the message. Storage failures prevent sending.
      localStorage.setItem(storageKey, JSON.stringify(receipt));
      let result;
      if (receipt.status === 'accepted') result = receipt;
      else if (receipt.status === 'unknown' || receipt.status === 'rejected') result = receipt;
      else {
        await beforeSend();
        receipt.status = 'unknown';
        localStorage.setItem(storageKey, JSON.stringify(receipt));
        result = await request('send', { ...snapshot, request_id: receipt.request_id, confirmed: true });
        Object.assign(receipt, result, { recorded_at: Date.now(), ...context(), to: snapshot.to, subject: snapshot.subject });
        localStorage.setItem(storageKey, JSON.stringify(receipt));
      }
      const text = result.status === 'accepted' ? 'Your email provider accepted this request for sending. Check Sent mail for its status; delivery and removal are not confirmed.'
        : result.status === 'rejected' ? 'Your provider rejected this request. Check your account permissions and recipient address before preparing another request.'
          : 'Sending could not be confirmed. Check Sent mail before taking further action. This message will not be sent again automatically.';
      $('#send-review-status').textContent = text; $('#send-status').textContent = text;
      if (result.status === 'accepted') {
        if (result.followup) $('#send-review-status').textContent += ` Follow-up: ${result.followup.status}${result.followup.due_at ? `, due ${new Date(result.followup.due_at).toLocaleString()}` : ''}. Manage it in your dashboard.`;
        try { await onAccepted(); } catch { $('#send-status').textContent += ' The local report status could not be updated; mark it sent manually.'; }
      }
    } catch (error) { $('#send-review-status').textContent = `${error.message || 'Sending could not be confirmed.'} Check Sent mail and the dashboard before another attempt. Your draft has been kept.`; }
    finally { busy = false; $('#cancel-email-send').disabled = false; gate(); }
  });
  refresh();
  return { setChannel, setContacts(values) {
    contacts = values;
    $('#infrastructure-destination').replaceChildren(...contacts.map((contact, index) => {
      const option = document.createElement('option'); option.value = String(index); option.textContent = `${contact.name} — ${contact.kind}`; return option;
    }));
    setChannel(contacts[0] || null); choices.hidden = contacts.length < 2;
  } };
}
