// Text helpers: normalisation, name matching, URL canonicalisation, domain extraction.

export function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Saved scans keep the subject type in context; scanData may also expose it directly. */
export function isBusinessSubject(scan) {
  return scan?.subject_type === 'business' || scan?.context?.subject_type === 'business';
}

/** Every string that should count as the subject's name: full name, variants, handles. */
export function nameForms(fullName, variants = [], usernames = [], subjectType = 'person') {
  const forms = new Set();
  const add = (v, minLength = 2) => {
    const n = norm(v).replace(/^@/, '');
    if (n.length >= minLength) forms.add(n);
  };
  add(fullName);
  variants.forEach(v => add(v));
  usernames.forEach(v => add(v, 3));
  // Personal surname ordering does not apply to business names.
  const toks = norm(fullName).split(' ').filter(Boolean);
  if (subjectType !== 'business' && toks.length >= 2) {
    add([...toks.slice(1), toks[0]].join(' '));
    add([toks[toks.length - 1], ...toks.slice(0, -1)].join(' '));
  }
  return [...forms];
}

/** True if any name form appears as a phrase in the text (word-boundary aware; also matches squashed handles). */
export function mentionsName(text, forms) {
  const t = norm(text);
  return forms.some((form) => {
    const f = norm(form).replace(/^@/, '');
    if (!f) return false;
    const fs = f.replace(/[\s._-]+/g, '');
    // Permit a full name written as a handle, without removing the boundaries
    // around the surrounding text (which made Anne Lee match Joanne Lee).
    const phrase = fs.length >= 6
      ? f.split(/[\s._-]+/).map(escapeRe).join('[\\s._-]*')
      : escapeRe(f);
    return new RegExp('(^|[^\\p{L}\\p{N}])' + phrase + '($|[^\\p{L}\\p{N}])', 'u').test(t);
  });
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_src|igshid|si$)/i;

export function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    let path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname}${path}${u.searchParams.toString() ? '?' + u.searchParams.toString() : ''}`;
  } catch {
    return String(raw).toLowerCase();
  }
}

const TWO_LEVEL = new Set([
  'com.sg', 'edu.sg', 'gov.sg', 'org.sg', 'net.sg', 'per.sg',
  'com.my', 'org.my', 'edu.my', 'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au',
  'co.id', 'or.id', 'com.ph', 'co.nz', 'co.jp', 'co.kr', 'com.hk', 'com.tw', 'com.cn', 'co.in', 'co.th',
]);

export function hostOf(raw) {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** Registrable domain, e.g. forums.hardwarezone.com.sg -> hardwarezone.com.sg */
export function registrableDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return TWO_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
}

export function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
