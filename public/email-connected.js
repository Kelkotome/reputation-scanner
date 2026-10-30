const connected = location.hash === '#connected';
document.querySelector('#connection-title').textContent = connected ? 'Email connected' : 'Email was not connected';
document.querySelector('#connection-result').textContent = connected
  ? 'Return to your report, check the connected address and expiry, finish reviewing your email, then choose Review & send. No email has been sent.'
  : location.hash === '#mismatch' ? 'The authorised mailbox does not match the sending address in your request. Return and connect that exact account, or change the sending address and review your draft. No email has been sent.'
  : 'The connection was cancelled, expired, or could not be completed. Return to your report and try connecting again. No email has been sent.';
history.replaceState(null, '', location.pathname);
document.querySelector('#close-connection').addEventListener('click', () => window.close());
