// Reputation lexicon: the negative patterns people search after someone's name.
// priority 1 = scam / crime / court, 2 = accusation / defamation, 3 = doxxing / harassment / reviews.
// Intimate-image cases are NOT searched. They are routed to OSC / StopNCII / Take It Down (see help.html).

export const TERMS = [
  // 1: scam / crime / legal
  { t: 'scam', p: 1, cat: 'scam_fraud' },
  { t: 'scammer', p: 1, cat: 'scam_fraud' },
  { t: 'fraud', p: 1, cat: 'scam_fraud' },
  { t: 'cheat', p: 1, cat: 'scam_fraud' },
  { t: 'police', p: 1, cat: 'crime_legal' },
  { t: 'arrested', p: 1, cat: 'crime_legal' },
  { t: 'charged', p: 1, cat: 'crime_legal' },
  { t: 'jailed', p: 1, cat: 'crime_legal' },
  { t: 'court', p: 1, cat: 'crime_legal' },
  { t: 'sued', p: 1, cat: 'crime_legal' },
  { t: 'lawsuit', p: 1, cat: 'crime_legal' },
  { t: 'penipu', p: 1, cat: 'scam_fraud' },   // Malay
  { t: '骗子', p: 1, cat: 'scam_fraud' },     // Chinese

  // 2: accusation / defamation
  { t: 'scandal', p: 2, cat: 'defamation_accusation' },
  { t: 'exposed', p: 2, cat: 'defamation_accusation' },
  { t: 'beware', p: 2, cat: 'defamation_accusation' },
  { t: 'liar', p: 2, cat: 'defamation_accusation' },
  { t: 'fake', p: 2, cat: 'defamation_accusation' },
  { t: 'blacklist', p: 2, cat: 'defamation_accusation' },
  { t: 'skandal', p: 2, cat: 'defamation_accusation' }, // Malay
  { t: '丑闻', p: 2, cat: 'defamation_accusation' },

  // 3: doxxing / harassment / reviews / forums
  { t: 'address', p: 3, cat: 'doxxing_personal_info' },
  { t: 'phone number', p: 3, cat: 'doxxing_personal_info' },
  { t: 'nric', p: 3, cat: 'doxxing_personal_info' },
  { t: 'harassment', p: 3, cat: 'harassment' },
  { t: 'complaint', p: 3, cat: 'negative_news_forum' },
  { t: 'review', p: 3, cat: 'negative_news_forum' },
  { t: 'reddit', p: 3, cat: 'negative_news_forum' },
  { t: 'hardwarezone', p: 3, cat: 'negative_news_forum' },
];

// Site-scoped queries (priority 4): where call-outs and complaints cluster.
export const SITES = [
  'reddit.com',
  'forums.hardwarezone.com.sg',
  'facebook.com',
  'x.com',
  'tiktok.com',
  'glassdoor.com',
  'trustpilot.com',
  'complaintsboard.com',
];

/** Terms that, found in a title/snippet, indicate each category (heuristic classifier + autocomplete scoring). */
export const CATEGORY_SIGNALS = {
  scam_fraud: ['scam', 'scammer', 'fraud', 'cheat', 'penipu', '骗子', 'ponzi', 'con man', 'money not returned'],
  crime_legal: ['police', 'arrested', 'charged', 'jailed', 'jail', 'court', 'sued', 'lawsuit', 'convicted', 'sentenced', 'offence'],
  defamation_accusation: ['scandal', 'defamation', 'defamatory', 'slander', 'libel', 'allegation', 'accusation', 'accused', 'rumour', 'rumor', 'exposed', 'beware', 'liar', 'fake', 'blacklist', '丑闻', 'skandal', 'call out', 'callout'],
  doxxing_personal_info: ['address', 'phone number', 'nric', 'ic number', 'lives at', 'home address', 'contact number', 'doxxing', 'doxxed', 'data leak', 'personal data exposed', 'private information exposed'],
  harassment: ['harassment', 'stalker', 'stalking', 'threat', 'bully', 'bullying'],
  negative_news_forum: ['complaint', 'bad review', 'warning', 'avoid', 'terrible', 'worst', '1 star', 'one star'],
};

export const CATEGORY_BASE_SEVERITY = {
  crime_legal: 4,
  scam_fraud: 4,
  doxxing_personal_info: 4,
  defamation_accusation: 3,
  harassment: 3,
  negative_news_forum: 2,
  sensitive_intimate: 5,
};

export const CATEGORY_LABELS = {
  scam_fraud: 'Scam / fraud accusation',
  crime_legal: 'Crime or court allegation',
  defamation_accusation: 'Accusation / call-out',
  doxxing_personal_info: 'Personal info exposed',
  harassment: 'Harassment',
  negative_news_forum: 'Negative review, news or forum post',
  sensitive_intimate: 'Sensitive / intimate content',
  neutral: 'Neutral mention',
  same_name_other_person: 'Same name, probably not you',
};

export const NEGATIVE_CATEGORIES = new Set([
  'scam_fraud', 'crime_legal', 'defamation_accusation', 'doxxing_personal_info',
  'harassment', 'negative_news_forum', 'sensitive_intimate',
]);
