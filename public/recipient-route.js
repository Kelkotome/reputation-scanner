// Never derive an inbox by prepending abuse@ to an arbitrary domain.
export function recipientRoute(channel) {
  const validEmail = value => typeof value === 'string' && /^[^\s@<>\r\n,;]+@[^\s@<>\r\n,;]+\.[^\s@<>\r\n,;]+$/.test(value);
  const https = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  };
  const form = https(channel?.form);
  if (form) return { kind: 'form', email: '', url: form, label: `${channel.name || 'This platform'} uses a reporting form. The correct route is selected below.` };
  if (validEmail(channel?.email) && https(channel?.source)) return { kind: 'email', email: channel.email, url: https(channel.source),
    label: channel.kind ? `Escalation contact selected automatically: ${channel.name}. ${channel.how} Review the destination before sending.`
      : `Recipient selected automatically from ${channel.name || 'the platform'}’s published reporting contact${channel.verified_on ? ` (checked ${channel.verified_on})` : ''}. Review it before sending.` };
  if (channel) return { kind: 'manual', email: '', url: '', label: channel.how || 'Use this platform’s in-app Report action. No verified email is available.' };
  return { kind: 'unknown', email: '', url: '', label: 'No verified reporting contact is available for this domain yet. Ask us to identify the correct destination, or enter an address you have verified.' };
}
