// Requests are editable correspondence, not legal advice or findings about a page.
import { registrableDomain, hostOf, clip, isBusinessSubject } from './text.js';

const field = (value, fallback, max = 300) => clip(String(value || '').replace(/[\r\n]+/g, ' ').trim(), max) || fallback;
const name = (c) => field(c.full_name || c.name, '[Your name]', 80);
const url = (c) => String(c.url || '[Page URL]').replace(/[\r\n]+/g, ' ');
const representative = (c) => field(c.representative_name || c.context?.representative_name, '[Representative name]', 80);
const signature = (c) => isBusinessSubject(c) ? `${representative(c)}\nOn behalf of ${name(c)}` : name(c);
const end = (c) => `I confirm that the statements I provide in this request are accurate to the best of my knowledge.\n\nThank you,\n${signature(c)}\nContact: ${field(c.email, '[Your contact email]', 254)}`;
const message = (c, text) => `Hello,\n\nPage: ${url(c)}\n\n${text}\n\n${end(c)}`;

export const TEMPLATES = {
  general_removal: {
    id: 'general_removal', label: 'Request removal of a page or post',
    subject: () => 'Request to review and remove content',
    body: (c) => message(c, `Please review the content about ${isBusinessSubject(c) ? name(c) : 'me'} on this page.\nContent concerned: [Identify the passage, image or post].\nReason for my request: [Explain your concern and provide relevant supporting facts].\nPlease consider removing the identified content. If removal is not appropriate under your policies, please explain whether correction or redaction is available and how I can provide supporting information.`),
  },
  policy_review: {
    id: 'policy_review', label: 'Report a platform policy concern',
    subject: () => 'Removal request for a possible policy breach',
    body: (c) => message(c, `I am requesting removal of the identified content for a possible breach of your policies.\nContent concerned: [Identify the specific material].\nRelevant policy: [Name or link the policy you believe applies].\nReason for review: [Explain the possible breach using facts you can verify].\nPlease remove this content if your review confirms a breach. Please confirm the outcome or explain the reason if you decline and any available appeal process.`),
  },
  anonymise: {
    id: 'anonymise', label: 'Redact my name or identifying details',
    subject: () => 'Request to redact identifying details',
    body: (c) => message(c, `Please consider redacting my name or other identifying details on this page.\nDetails to redact: [Describe their location without repeating sensitive information].\nReason: [Explain your privacy concern and the impact of identification].\nIf keeping the underlying article or discussion is appropriate, please consider removing these identifying details while preserving its meaning. Please let me know what information you need to assess this request.`),
  },
  harassment: {
    id: 'harassment', label: 'Report harassment or targeted abuse',
    subject: () => 'Request to remove targeted abusive content',
    body: (c) => message(c, `I am requesting removal of content targeting ${isBusinessSubject(c) ? name(c) : 'me'} for possible harassment or abuse under your policies.\nSpecific content: [Identify the relevant statements or actions].\nContext: [Describe what happened and include dates or references you can verify].\nApplicable policy: [Identify the relevant rule, if known].\nPlease remove the identified content if your review confirms a breach. Please confirm the outcome or explain any available appeal process if you decline.`),
  },
  follow_up: {
    id: 'follow_up', label: 'Follow up on a previous request',
    subject: () => 'Follow-up on a content review request',
    body: (c) => message(c, `I am following up on my earlier request concerning this page.\nOriginal request date: [Date sent].\nReference number: [Reference, if available; otherwise remove this line].\nRequested action: [Summarise your original request].\nPrevious response or new information: [Summarise any response and relevant updates, or state that you have not received a reply].\nPlease let me know the status of the review and whether you need anything further. If the request was declined, please explain any available review or appeal process.`),
  },
  personal_info: {
    id: 'personal_info', label: 'Remove personal information',
    subject: () => 'Request to remove personal information',
    body: (c) => message(c, `I am requesting a privacy review of information identifying me on this page.\nInformation to review: [Describe the type and location of the personal information; avoid repeating sensitive details].\nPlease remove or redact this information under your privacy policy. [Explain why you believe the information should not be public]. Please let me know if you need anything further to assess my request.`),
  },
  inaccurate: {
    id: 'inaccurate', label: 'Request removal of an inaccurate claim',
    subject: () => 'Request to remove inaccurate information',
    body: (c) => message(c, `I am requesting removal of the identified claim about ${isBusinessSubject(c) ? name(c) : 'me'} on this page.\nClaim concerned: [Identify the exact statement and its location].\nReason I believe it is inaccurate: [Explain the error and identify supporting evidence; lack of verification alone does not establish that a claim is false].\nPlease remove the claim if your review confirms the issue and confirm the outcome. If you decline removal, please explain why and whether a correction is available. Please tell me how to submit supporting information privately.`),
  },
  outdated: {
    id: 'outdated', label: 'Request removal of outdated content',
    subject: () => 'Request to remove outdated content',
    body: (c) => message(c, `I am requesting removal of outdated content about ${isBusinessSubject(c) ? name(c) : 'me'} on this page.\nContent concerned: [Identify the passage and publication date].\nWhat changed: [Describe the change, date and supporting source].\nReason for removal: [Explain why removal is appropriate in these circumstances].\nPlease consider removing the identified content under your editorial policy and confirm your decision. If you decline, please explain why and whether an update${isBusinessSubject(c) ? '' : ' or removal of identifying details'} is available.`),
  },
  review: {
    id: 'review', label: 'Request removal of a policy-breaking review',
    subject: () => 'Request to remove a review under your guidelines',
    body: (c) => message(c, `Please assess this review against your review guidelines.\nReview and concern: [Identify the review and explain why you believe it is fake or violates a specific guideline].\nRelevant guideline: [Name or link the applicable guideline].\nSupporting information: [Provide facts you can verify].\nPlease remove the review if it does not meet your policy, or let me know what further information is needed.`),
  },
  same_name: {
    id: 'same_name', label: 'Clarify a same-name mix-up',
    subject: () => 'Request to clarify a same-name mix-up',
    body: (c) => message(c, isBusinessSubject(c)
      ? `I am writing on behalf of ${name(c)}. This page appears to refer to a different business with the same or a similar name.\nDistinction: [Explain the relevant difference and identify supporting evidence].\nPlease consider adding a clarifying note, or correcting the business name where it has been incorrectly used, to avoid confusion between the businesses. Please tell me how to provide supporting information.`
      : `My name is ${name(c)}, but I am not the person described on this page.\nDistinction: [Explain the relevant difference without disclosing unnecessary personal information].\nPlease consider adding a clarifying note, or removing my name where it has been incorrectly used, to avoid confusion between two different people. I can provide relevant clarification through a suitable private channel if needed.`),
  },
  copyright: {
    id: 'copyright', label: 'Request removal of your copied work',
    subject: (c) => `Request to review use of ${isBusinessSubject(c) ? 'copyrighted work' : 'my copyrighted work'}`,
    body: (c) => message(c, `${isBusinessSubject(c)
      ? (c.owns_content === true || c.ownsContent === true
        ? `${name(c)} owns the work identified below. I am writing on its behalf to request a review of its use on this page.`
        : '[Identify the copyright owner and confirm your authority to act for them]. Please review use of the work identified below.')
      : 'I am the owner of the work identified below and ask you to review its use on this page.'}\nOriginal work: [Describe ${isBusinessSubject(c) ? 'the business’s' : 'your'} original text or photograph and its original location].\nCopied material: [Identify the material and its location on the page].\nAuthorisation: [Explain why you believe this use is not authorised by ${isBusinessSubject(c) ? 'the owner, its agent' : 'you, your agent'}, or applicable law].\nPlease remove the identified material if your review confirms unauthorised use. Please direct me to your copyright reporting process if additional information is required.\nElectronic signature: ${isBusinessSubject(c) ? representative(c) : name(c)}\nDate: [Date]\nAdditional contact details, if required by your reporting form: [Address and telephone]`),
  },
};

function isReview(hit) {
  const domain = registrableDomain(hostOf(hit.url));
  return ['trustpilot.com', 'glassdoor.com'].includes(domain)
    || /\b(review|reviews|rating|ratings)\b/i.test(`${hit.title || ''} ${hit.snippet || ''}`)
    || (domain === 'google.com' && /\/maps(?:\/|\?|$)/.test(hit.url || ''));
}

/** Eligible ids only. Ownership is an explicit assertion, never inferred from a snippet. */
export function templatesFor(hit, { isMinor = false, ownsContent = false, subjectType = 'person' } = {}) {
  if (!hit || hit.category === 'sensitive_intimate') return [];
  const ids = [];
  if (hit.category === 'doxxing_personal_info' && subjectType !== 'business') ids.push('personal_info');
  if (['defamation_accusation', 'scam_fraud', 'harassment'].includes(hit.category)) ids.push('inaccurate');
  if (hit.category === 'crime_legal') ids.push('outdated');
  if (hit.category === 'negative_news_forum') ids.push(isReview(hit) ? 'review' : 'outdated');
  if (['doxxing_personal_info', 'defamation_accusation', 'scam_fraud', 'harassment', 'crime_legal', 'negative_news_forum'].includes(hit.category)) {
    ids.push('general_removal', 'policy_review');
    if (subjectType !== 'business') ids.push('anonymise');
    if (hit.category === 'harassment') ids.push('harassment');
    if (['sent', 'refused', 'escalated'].includes(hit.status)) ids.push('follow_up');
  }
  if (hit.status === 'not_me' && hit.match_confidence != null && Number.isFinite(Number(hit.match_confidence)) && Number(hit.match_confidence) < 0.5) ids.push('same_name');
  if (ownsContent === true && !isMinor) ids.push('copyright');
  return ids;
}
