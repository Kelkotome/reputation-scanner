// Suggestions only: a custom domain does not identify its mailbox provider.
export function senderProvider(address) {
  const domain = String(address).trim().toLowerCase().split('@')[1];
  if (['gmail.com','googlemail.com'].includes(domain)) return 'gmail';
  if (['outlook.com','hotmail.com','live.com','msn.com'].includes(domain)) return 'outlook';
  return 'choose';
}
export function senderMatches(entered, connected) {
  return Boolean(entered && connected && entered.trim().toLowerCase() === connected.trim().toLowerCase());
}
export function manualDraft({from,to,subject,body}) {
  const address = s => typeof s === 'string' && s.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s);
  if (!address(from) || !address(to) || typeof subject !== 'string' || !subject.trim() || subject.length>180 || /[\r\n\x00-\x1f\x7f]/.test(subject)
    || typeof body !== 'string' || !body.trim() || body.length>20000 || /\[[^\]\r\n]{2,300}\]/.test(subject+body)) throw new Error('Review the sender, recipient and message, and replace template placeholders first.');
  const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const encodedSubject = Array.from(subject).reduce((parts,c)=>{
    if (!parts.length || new TextEncoder().encode(parts[parts.length-1]+c).length>36) parts.push(c); else parts[parts.length-1]+=c; return parts;
  },[]).map(s=>`=?UTF-8?B?${b64(s)}?=`).join('\r\n ');
  return {
    mailto:`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    eml:`From: ${from}\r\nTo: ${to}\r\nSubject: ${encodedSubject}\r\nX-Unsent: 1\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body.replace(/\r?\n/g,'\r\n')).match(/.{1,76}/g).join('\r\n')}\r\n`,
  };
}
