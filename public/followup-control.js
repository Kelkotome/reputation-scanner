// Only random email request IDs cross this boundary; case IDs remain local.
export async function stopItemFollowups(recordId, itemId, reason = 'closed') {
  const pending = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i); if (!key?.startsWith('rep-email-send:')) continue;
    let r; try { r = JSON.parse(localStorage.getItem(key)); } catch { continue; }
    if (r?.record_id === recordId && (itemId == null || String(r.hit_id) === String(itemId)) && ['queued','pending','processing'].includes(r.followup?.status)) pending.push({key,r});
  }
  if (!pending.length) return;
  const response = await fetch('/api/email/followups', {credentials:'same-origin',cache:'no-store'});
  if (!response.ok) throw new Error('Check the dashboard and stop the queued follow-up before closing this item.');
  const result = await response.json();
  if (!result.connected) throw new Error('Your email session is unavailable. Reconnect to cancel previous follow-ups, then refresh the dashboard before closing this item.');
  for (const {key,r} of pending) {
    const job = result.jobs.find(j => j.request_id === r.request_id);
    if (job && ['queued','pending','processing'].includes(job.status)) {
      const cancelled = await fetch('/api/email/cancel-followup', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:r.request_id,reason})});
      if (!cancelled.ok) throw new Error('Follow-up cancellation could not be confirmed. Check the dashboard and Sent mail before closing this item.');
      r.followup = {...job,status:reason,updated_at:Date.now()};
    } else r.followup = job || {...r.followup,status:'no_longer_active',updated_at:Date.now()};
    localStorage.setItem(key,JSON.stringify(r));
  }
}
export function forgetRecordMetadata(recordId) {
  const keys = Array.from({length:localStorage.length},(_,i)=>localStorage.key(i));
  for (const key of keys) {
    if (key === `rep-report-notes:${recordId}`) localStorage.removeItem(key);
    if (!key?.startsWith('rep-email-send:')) continue;
    let r;try { r=JSON.parse(localStorage.getItem(key)); } catch {continue;}
    if (r?.record_id === recordId) localStorage.setItem(key,JSON.stringify({request_id:r.request_id,status:r.status}));
  }
}
