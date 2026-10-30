// Pure, escaped presentation. PR exports intentionally omit identity, URLs,
// titles, free-text narratives and email addresses rather than guessing redactions.
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const e = escapeHtml;
export const timestamp = value => value && Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : 'Not recorded';
function domain(value) { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.hostname : 'Invalid URL'; } catch { return 'Not recorded'; } }
const hasEarlierObservation = item => item.discovery_origin === 'previous_scan' || Number.isSafeInteger(item.previous_observed_at);
function earlierObservation(item) {
  if (!hasEarlierObservation(item)) return '';
  const observed = item.previous_observed_at ?? item.last_seen_at ?? item.created_at;
  const returned = item.reobserved_at
    ? `<br>Returned again in this scan: ${e(timestamp(item.reobserved_at))}.` : '';
  const label = item.discovery_origin === 'previous_scan' ? 'Retained from an earlier scan' : 'Includes an earlier saved observation';
  return `<br><strong>${label}</strong><br><small>Earlier observation: ${e(timestamp(observed))}.${returned}</small>`;
}
export function reportMarkup(record, { version = 'police', notes = {}, receipts = [], generated = Date.now(), emailCheckedAt = null, logo = '/assets/logo-123-colour.png' } = {}) {
  const pr = version === 'pr';
  const title = { police: 'Incident summary for police', legal: 'Case briefing for a law firm', pr: 'Reputation response briefing' }[version] || 'Incident summary';
  const items = record.kind === 'scan' ? record.items.slice(0, 20) : record.items;
  const historical = items.some(hasEarlierObservation);
  const includedIds = new Set(items.map(item => String(item.id)));
  const relevant = receipts.filter(r => r.record_id === record.id && includedIds.has(String(r.hit_id)));
  const changes = items.flatMap((item,index) => (item.history || []).map(change=>({...change,item:index+1}))).sort((a,b)=>a.at-b.at);
  const narrative = pr ? '<p>Identity, contact details, full URLs, titles and personal notes are omitted from this PR version. Review source domains before sharing.</p>' : `<h2>Reporter’s account</h2><p class="preserve">${e(notes.narrative || 'No account supplied. The reporter should describe what happened, when they became aware, and the impact in their own words.')}</p><h2>Supporting material and references</h2><p class="preserve">${e(notes.evidence || 'No supporting material recorded. Add references to evidence kept separately, correspondence and existing case numbers.')}</p>`;
  return `<header class="document-brand"><svg viewBox="0 0 240 54" width="240" height="54" role="img" aria-label="123 Reputation Management"><svg width="48" height="54" viewBox="338 188 402 452"><image href="${e(logo)}" width="1080" height="1080"/></svg><svg x="59" y="7" width="181" height="41" viewBox="178 650 725 163"><image href="${e(logo)}" width="1080" height="1080"/></svg></svg><span>PRIVATE · FOR RECIPIENT REVIEW</span></header>
  <p class="eyebrow">123 Reputation Management · Supporting report</p><h1>${title}</h1>
  ${record.provider === 'mock' || record.is_demo ? '<p class="report-warning">DEMO — FICTIONAL TEST DATA. Not suitable for submission as an actual incident.</p>' : ''}
  <dl>${pr ? '' : `<dt>Report reference</dt><dd>${e(record.id)}</dd>`}<dt>Generated</dt><dd>${e(timestamp(generated))}</dd><dt>Record created</dt><dd>${e(timestamp(record.created_at))}</dd>
  ${pr ? '' : `<dt>Affected person / organisation</dt><dd>${e(record.name)}</dd><dt>Prepared by</dt><dd>${e(notes.reporter || record.reporter_name || 'Not supplied')}</dd><dt>Contact</dt><dd>${e(notes.email || record.reporter_email || 'Not supplied')}</dd>`}
  <dt>Source</dt><dd>${record.kind === 'scan' ? historical
    ? `Locally saved search result metadata, including earlier scans (current scan provider: ${e(record.provider || 'not recorded')})`
    : `Search result metadata (${e(record.provider || 'not recorded')})` : 'URLs entered by the reporter'}</dd></dl>
  <p class="report-warning">This is a supporting summary, not an official police report, legal finding, proof of publication or a forensic capture. Search matches and allegations have not been independently verified. Provider acceptance of an email does not confirm delivery or removal.</p>
  ${narrative}<h2>Recorded content (${items.length})</h2>
  ${historical ? '<p>Earlier observations retained from saved scans are labelled below. Saving them in this report does not verify that the source is still available or that a missing search result was removed.</p>' : ''}
  ${record.partial ? '<p>Search coverage is incomplete.</p>' : ''}${record.hidden_count ? `<p>${e(record.hidden_count)} additional results are outside this report’s preview allowance. Contact 123 Reputation Management for further help.</p>` : ''}
  <table><thead><tr><th>Item</th><th>${pr ? 'Domain' : 'Title / URL'}</th><th>Recorded status</th></tr></thead><tbody>${items.map((item, i) => `<tr><td>${i + 1}</td><td>${pr ? e(domain(item.url)) : `${e(item.title || 'Reporter-supplied URL')}<br><span class="url">${e(item.url)}</span>`}${item.kind === 'autocomplete' ? '<br><strong>Search suggestion; not a published-page finding</strong>' : ''}${earlierObservation(item)}</td><td>${e(item.status || 'Not recorded')}<br><small>User-maintained status</small></td></tr>`).join('')}</tbody></table>
  <h2>Action chronology</h2><p>Times are UTC. Manual entries are distinguished from provider responses. No email body or private imagery is attached. This browser-stored log is not a provider-certified record; retain original Sent mail separately.</p><p>${emailCheckedAt ? `Email follow-up statuses checked at ${e(timestamp(emailCheckedAt))}.` : 'Current email follow-up status could not be verified. Any entries below show the last saved status and may be out of date.'}</p>
  <ul>${items.flatMap((item, i) => [item.sent_at ? `<li>${e(timestamp(item.sent_at))} — Item ${i + 1}: initial request marked sent by the user.${!pr && item.reference ? ` Reference: ${e(item.reference)}` : ''}</li>` : '', item.followed_up_at ? `<li>${e(timestamp(item.followed_up_at))} — Item ${i + 1}: follow-up marked sent by the user.</li>` : '']).join('')}
  ${relevant.map(r => `<li>${e(timestamp(r.recorded_at))} — Item ${items.findIndex(i => String(i.id) === String(r.hit_id)) + 1}: ${r.message_kind === 'followup' ? 'manually initiated follow-up' : 'initial email'}: ${e(r.status)} (provider submission outcome)${pr ? '' : `; recipient ${e(r.to)}`}. Receipt ${e(r.request_id)}.${r.followup ? `<br>Follow-up ${e(r.followup.status)}; due ${e(timestamp(r.followup.due_at))}; last recorded update ${e(timestamp(r.followup.updated_at))}.` : ''}</li>`).join('')}</ul>
  ${!relevant.length && !items.some(i => i.sent_at || i.followed_up_at) ? '<p>No dated sending records are available. A “sent” item status alone does not verify that an email was sent.</p>' : ''}
  ${changes.length ? `<h2>Recorded status changes</h2><p>These are local status entries, not independent verification of removal. Up to 250 recent changes per item are retained; older records may have no history.</p><ul>${changes.map(change=>`<li>${e(timestamp(change.at))} — Item ${change.item}: ${e(change.status)}</li>`).join('')}</ul>` : ''}
  <h2>Requested outcome</h2><p>${pr ? 'Coordinate a factual response and track requests to remove the reported content.' : 'Review the reported incident and supporting material, advise on appropriate next steps, and assist with removal of the reported content where appropriate.'}</p>
  <footer>Prepared with 123 Reputation Management. The reporter should check accuracy and provide original supporting records separately. This report has not been submitted to any recipient.</footer>`;
}
