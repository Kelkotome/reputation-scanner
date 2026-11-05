// Never derive an inbox by prepending abuse@ to an arbitrary domain.
export function recipientRoute(channel) {
  const validEmail = value => typeof value === 'string' && /^[^\s@<>\r\n,;]+@[^\s@<>\r\n,;]+\.[^\s@<>\r\n,;]+$/.test(value);
  const https = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  };
  const form = https(channel?.form);
  if (form) return { kind: 'form', email: '', url: form, label: `${channel.name || 'This platform'} takes reports through its own form. Copy your request, then paste it there.` };
  if (validEmail(channel?.email) && https(channel?.source)) return { kind: 'email', email: channel.email, url: https(channel.source),
    label: channel.kind ? `${channel.name} provides the website’s network or domain, and can pass your report on.`
      : `${channel.name || 'The platform'}’s published reporting address.` };
  if (channel) return { kind: 'manual', email: '', url: '', label: channel.how || 'Use the Report button inside this platform’s app.' };
  return { kind: 'unknown', email: '', url: '', label: 'We don’t have a reporting address for this site yet. Ask us, or enter one you’ve checked.' };
}
