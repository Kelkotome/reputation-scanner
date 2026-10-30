// Delivers an explicitly submitted assistance request to the operator's inbox
// through Cloudflare's native send_email binding. The MIME message is built by
// hand: plain text, UTF-8, base64 body and RFC 2047 encoded headers, so no
// user-supplied value can add or split a header line.

export const HELP_TYPE_LABELS = Object.freeze({
  legal: 'Legal advice from a qualified professional',
  pr: 'Reputation and PR support',
  investigator: 'Investigation support',
  unsure: 'Not sure yet',
});

// Conservative ASCII address syntax (dot-atom local part, LDH domain labels).
// Anything else is never placed in an address header.
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export function safeAddress(value) {
  return typeof value === 'string' && value.length <= 254 && ADDRESS.test(value) && value.split('@')[0].length <= 64;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
// Header text never contains CR/LF. Printable ASCII passes through; anything
// else becomes UTF-8 encoded-words of at most 75 characters each.
export function encodeHeaderText(value) {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean) && !/=\?/.test(clean)) return clean;
  const words = [];
  let chunk = '';
  for (const char of clean) {
    if (base64Utf8(chunk + char).length > 60) { words.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map(word => `=?UTF-8?B?${base64Utf8(word)}?=`).join('\r\n ');
}
function addressHeader(address, name) {
  if (!safeAddress(address)) throw new Error('invalid_address');
  if (!name) return `<${address}>`;
  const display = String(name).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Plain ASCII names become a quoted string; others become encoded-words.
  const phrase = /^[\x20-\x7e]*$/.test(display) && !/=\?/.test(display)
    ? `"${display.replace(/["\\]/g, '')}"` : encodeHeaderText(display);
  return `${phrase} <${address}>`;
}

export function buildMime({ from, to, replyTo, replyToName, subject, text, date, messageId }) {
  const headers = [
    `From: ${addressHeader(from, 'Reputation Scanner')}`,
    `To: ${addressHeader(to)}`,
    ...(replyTo && safeAddress(replyTo) ? [`Reply-To: ${addressHeader(replyTo, replyToName)}`] : []),
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${new Date(date).toUTCString()}`,
    `Message-ID: <${messageId}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  const body = base64Utf8(String(text).replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

export function assistanceText({ id, createdAt, helpType, name, email, message, links = [], attachment = null }) {
  const shared = [...links, ...(attachment?.results || []).map(result => result.title ? `${result.url}  (${result.title})` : result.url)];
  return [
    'New assistance request from the Reputation Scanner.',
    '',
    `Help type: ${HELP_TYPE_LABELS[helpType] || helpType}`,
    `Name: ${name}`,
    `Reply-to email: ${email}${safeAddress(email) ? '' : ' (not used as Reply-To: unusual address format)'}`,
    `Submitted: ${new Date(createdAt).toISOString()}`,
    `Request ID: ${id}`,
    '',
    'Message:',
    message || '(no message)',
    '',
    'Shared links (may include private or non-indexed links; not fetched or checked by the app):',
    ...(shared.length ? shared.map(link => `- ${link}`) : ['(none)']),
    ...(attachment ? ['', `Report subject: ${attachment.subject_name} (${attachment.subject_type})${attachment.country ? `, ${attachment.country}` : ''}`] : []),
    '',
    'The user consented to sending these details to 123 Reputation Management for follow-up.',
    'Ask the user before sharing any of this with a partner organisation.',
  ].join('\n');
}

export function assistanceMailConfigured(env) {
  return Boolean(env.ASSISTANCE_MAIL && typeof env.ASSISTANCE_MAIL.send === 'function'
    && safeAddress(env.ASSISTANCE_TO) && safeAddress(env.ASSISTANCE_FROM));
}

// Returns true only when the binding accepted the message. Never throws: any
// failure leaves the caller to keep the request so it is not lost.
export async function sendAssistanceEmail(env, request, EmailMessage) {
  if (!assistanceMailConfigured(env) || typeof EmailMessage !== 'function') return false;
  try {
    const raw = buildMime({
      from: env.ASSISTANCE_FROM, to: env.ASSISTANCE_TO, replyTo: request.email, replyToName: request.name,
      subject: `Reputation Scanner assistance: ${HELP_TYPE_LABELS[request.helpType] || request.helpType} from ${request.name}`,
      text: assistanceText(request), date: request.createdAt, messageId: request.id,
    });
    await env.ASSISTANCE_MAIL.send(new EmailMessage(env.ASSISTANCE_FROM, env.ASSISTANCE_TO, raw));
    return true;
  } catch {
    return false;
  }
}
