import { listSaved, reportData } from '/local-api.js?v=20261004-ai';
import { reportMarkup, timestamp } from '/report-export.js?v=20261004-ai';
const $ = id => document.getElementById(id);
let records = [], current = null, receipts = [], jobs = [], generation = 0;
let emailCheckedAt = null;
function readReceipts() {
  const result = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('rep-email-send:')) continue;
    try { const value = JSON.parse(localStorage.getItem(key)); if (value?.request_id) result.push({ ...value, storageKey: key }); } catch { /* Invalid local entry is ignored. */ }
  }
  return result;
}
async function emailApi(path, body) {
  const response = await fetch(`/api/email/${path}`, { method: body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(25000), headers: body ? { 'Content-Type':'application/json' } : {}, ...(body ? { body:JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Email service unavailable'); return result;
}
async function recoveryControls() {
  const panel = document.createElement('div');
  const explanation = document.createElement('p'); explanation.className = 'hint';
  explanation.textContent = 'Lost your connection? Sign back into the same email address below to recover its follow-up history and cancel its old queued follow-ups. This does not read your inbox.';
  panel.append(explanation); $('followup-status').after(panel);
  try {
    const status = await emailApi('status');
    for (const provider of ['gmail','outlook']) {
      const button = document.createElement('button'); button.className = 'button secondary'; button.textContent = `Recover with ${provider === 'gmail' ? 'Gmail' : 'Outlook'}`;
      button.disabled = !status.providers[provider]; panel.append(button);
      button.onclick = async () => {
        const popup = window.open('about:blank','_blank');
        if (!popup) { $('followup-status').textContent = 'Allow popups for account recovery.'; return; }
        popup.opener = null;
        try { const result = await emailApi('connect',{provider,offline:false}); popup.location.href = result.url; }
        catch(error) { popup.close(); $('followup-status').textContent = error.message; }
      };
    }
    if (!Object.values(status.providers).some(Boolean)) explanation.textContent += ' Email sending and recovery are awaiting provider setup by the app owner.';
  } catch { explanation.textContent += ' Connection options are temporarily unavailable.'; }
}
async function refreshJobs() {
  $('followup-status').textContent = 'Checking scheduled follow-ups…';
  try {
    const result = await emailApi('followups'); jobs = result.jobs; receipts = readReceipts(); emailCheckedAt = result.connected ? Date.now() : null;
    for (const job of jobs) {
      const receipt = receipts.find(r => r.request_id === job.request_id);
      if (receipt) { receipt.followup = job; if (job.first_sent_at) { receipt.status = 'accepted'; receipt.recorded_at = job.first_sent_at; } const { storageKey, ...saved } = receipt; localStorage.setItem(storageKey, JSON.stringify(saved)); }
    }
    $('followup-status').textContent = !result.connected ? 'No connected email session. Connect through a request draft with automatic follow-ups enabled. Saved receipts remain in your reports.' : jobs.length ? `${jobs.length} follow-up record(s). “Accepted” means provider acceptance, not confirmed delivery.` : 'No automatic follow-ups scheduled for this connection.';
    $('followup-list').replaceChildren();
    for (const job of jobs) {
      const receipt = receipts.find(r => r.request_id === job.request_id);
      const card = document.createElement('section'); card.className = 'followup-card';
      const title = document.createElement('h3'); title.textContent = receipt?.subject || `Request ${job.request_id}`;
      const description = document.createElement('p'); description.textContent = `${receipt?.to || 'Recipient in the original request'} · ${job.status} · Due: ${timestamp(job.due_at)}`;
      card.append(title, description);
      if (['queued','pending','processing'].includes(job.status)) for (const [reason, label] of [['replied','Reply received — stop follow-up'],['closed','Close request — stop follow-up'],['cancelled','Cancel follow-up']]) {
        const button = document.createElement('button'); button.className = 'button secondary'; button.textContent = label;
        button.onclick = async () => { button.disabled = true; try { await emailApi('cancel-followup', { request_id: job.request_id, reason }); await refreshJobs(); } catch(error) { $('followup-status').textContent = error.message; button.disabled = false; } };
        card.append(button);
      }
      $('followup-list').append(card);
    }
    render();
  } catch(error) { emailCheckedAt = null; $('followup-status').textContent = `Follow-up status unavailable: ${error.message}. Saved receipts may be out of date.`; }
}
function notes() { return { reporter:$('reporter').value, email:$('contact-email').value, narrative:$('narrative').value, evidence:$('evidence').value }; }
function render() { if (current) { $('report-preview').innerHTML = reportMarkup(current, { version:$('report-version').value, notes:notes(), receipts, emailCheckedAt }); $('report-preview').hidden = false; } }
async function freshExport() {
  if (!current) throw new Error('Select a saved record first.');
  const id = current.id, kind = current.kind;
  const fresh = await reportData(kind,id);
  await refreshJobs();
  if (!current || current.id !== id) throw new Error('The selection changed. Review the new record and export again.');
  current = fresh; render();
  return {record:current,options:{version:$('report-version').value,notes:notes(),receipts:[...receipts],emailCheckedAt}};
}
async function selectRecord() {
  const token = ++generation, chosen = records[Number($('record').value)];
  current = null; $('report-controls').hidden = true; $('report-preview').hidden = true;
  if ($('record').value === '' || !chosen) return;
  try {
    const data = await reportData(chosen.kind, chosen.id); if (token !== generation) return; current = data;
    const saved = JSON.parse(localStorage.getItem(`rep-report-notes:${current.id}`) || '{}');
    $('reporter').value = saved.reporter || current.reporter_name || ''; $('contact-email').value = saved.email || current.reporter_email || '';
    $('narrative').value = saved.narrative || ''; $('evidence').value = saved.evidence || '';
    $('record-status').textContent = `${current.items.length} included item(s)${current.hidden_count ? ` · ${current.hidden_count} additional search results excluded` : ''}.`;
    $('notes-status').textContent = ''; $('report-controls').hidden = false; render();
  } catch(error) { $('record-status').textContent = error.message; }
}
for (const id of ['reporter','contact-email','narrative','evidence']) $(id).addEventListener('input', () => {
  if (!current) return;
  try { localStorage.setItem(`rep-report-notes:${current.id}`, JSON.stringify(notes())); $('notes-status').textContent = 'Notes saved in this browser.'; } catch { $('notes-status').textContent = 'Notes could not be saved. Copy them before leaving this page.'; }
  render();
});
$('record').onchange = selectRecord; $('report-version').onchange = render; $('refresh-followups').onclick = refreshJobs;
$('print-report').onclick = async () => { try { await freshExport(); window.print(); } catch(error) { $('dashboard-error').textContent = `Report not printed: ${error.message}`; } };
$('download-report').onclick = async () => {
  if (!current) return;
  try {
    const snapshot = await freshExport();
    const [css, logoResponse] = await Promise.all([fetch('/dashboard.css').then(r => r.text()), fetch('/assets/logo-123-colour.png')]);
    const logo = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; logoResponse.blob().then(blob => reader.readAsDataURL(blob), reject); });
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'"><title>123 Reputation — Supporting report</title><style>${css}</style><article class="report-document">${reportMarkup(snapshot.record, { ...snapshot.options, logo })}</article></html>`;
    const url = URL.createObjectURL(new Blob([html],{type:'text/html'})), a = document.createElement('a'); a.href = url; a.download = `123-report-${snapshot.options.version}-${snapshot.record.id.slice(0,8)}.html`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { $('dashboard-error').textContent = 'Export could not be prepared. Your preview remains available to print.'; }
};
try {
  receipts = readReceipts(); records = await listSaved();
  records.forEach((record,index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `${record.label} · ${record.kind === 'scan' ? 'Scan' : 'Removal case'} · ${new Date(record.created_at).toLocaleDateString()}`; $('record').append(option); });
  if (!records.length) $('record-status').textContent = 'No saved records in this browser. Start a scan or create a removal case first.';
  await refreshJobs();
  await recoveryControls();
} catch(error) { $('dashboard-error').textContent = error.message; }
window.addEventListener('focus',refreshJobs);
