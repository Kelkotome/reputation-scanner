// Partner sign-in page: shows the result of a Cloudflare Access sign-in and
// the current partner session. Sign-in itself is a plain link (/api/partner/login).
const $ = (selector) => document.querySelector(selector);
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...options });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
function showHashNotice() {
  $('#partner-not-registered').hidden = location.hash !== '#not-registered';
  $('#partner-unavailable').hidden = location.hash !== '#unavailable';
}
async function refresh() {
  showHashNotice();
  try {
    const session = await api('/api/operator/session');
    const partner = session.partner;
    $('#partner-signed-in').hidden = !partner;
    $('#partner-signed-out').hidden = Boolean(partner);
    if (partner) {
      const name = partner.organisation ? `${partner.email} (${partner.organisation})` : partner.email;
      $('#partner-summary').textContent = `Signed in as ${name}. ${partner.remaining_scans} of ${partner.daily_limit} scans left today (resets at 00:00 UTC).`;
      $('#partner-status').textContent = 'Partner access is active.';
    } else {
      $('#partner-status').textContent = session.operator === true ? 'You are signed in with operator access.' : 'You are not signed in.';
    }
  } catch {
    $('#partner-status').textContent = 'Your sign-in status could not be checked. You can still sign in.';
  }
}
$('#partner-logout').addEventListener('click', async () => {
  $('#partner-logout').disabled = true;
  try { await api('/api/operator/logout', { method: 'POST', body: '{}' }); history.replaceState(null, '', location.pathname); }
  catch { $('#partner-status').textContent = 'Sign-out could not be confirmed. Try again before leaving a shared device.'; }
  finally { $('#partner-logout').disabled = false; await refresh(); }
});
window.addEventListener('hashchange', showHashNotice);
refresh();
