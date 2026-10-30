// Presentation only: labels explain saved estimates without changing the
// classification, ranking, identity decision or finding's tracking status.
const topics = {
  scam_fraud: ['Scam or fraud wording', 'The search preview was flagged for wording associated with scams or fraud. This does not establish that anyone committed fraud.'],
  crime_legal: ['Crime or court wording', 'The search preview was flagged for wording associated with crime, police or court matters. The words may refer to unrelated content or another person.'],
  defamation_accusation: ['Accusations or rumours', 'The search preview was flagged for accusations, call-outs or rumours. The app has not verified the claims or determined whether they are defamatory.'],
  doxxing_personal_info: ['Contact or personal details', 'The search preview was flagged for contact or personal-information wording. A public contact listing is not necessarily a privacy breach.'],
  harassment: ['Harassment or threat wording', 'The search preview was flagged for wording associated with harassment or threats. Context and identity still need checking.'],
  negative_news_forum: ['Negative reviews or complaints', 'The search preview was flagged for critical reviews or complaint wording. The app has not checked whether the criticism is accurate or about you.'],
};

export function resultLabelView(hit = {}, { business = false } = {}) {
  const topic = Object.hasOwn(topics, hit.category) ? topics[hit.category] : null;
  const otherIdentity = hit.category === 'same_name_other_person' || hit.status === 'not_me';
  const ordinary = hit.category === 'neutral' && !otherIdentity;
  const severity = typeof hit.severity === 'number' && Number.isFinite(hit.severity) ? hit.severity : 0;
  const priority = otherIdentity ? 'identity' : topic ? severity >= 4 ? 'first' : 'next' : 'context';
  const priorityLabel = { identity: 'Check identity first', first: 'Review first', next: 'Review next', context: 'Review context' }[priority];
  const subject = business ? 'your business' : 'you';
  const confidence = hit.match_confidence;
  const identityLabel = hit.status === 'not_me' ? business ? 'Marked as a different business' : 'Marked as not about me'
    : otherIdentity ? business ? 'May be a different business' : 'May be someone else'
    : typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < .5 ? 'Identity not confirmed'
    : confidence >= .7 ? `More likely to be about ${subject}` : `May be about ${subject}`;
  return {
    topicLabel: otherIdentity ? business ? 'Similar business name' : 'Similar name'
      : topic ? `Possible concern: ${topic[0]}` : ordinary ? 'Ordinary name mention' : 'Mention to review',
    tone: otherIdentity ? 'identity' : topic ? 'concern' : 'ordinary',
    priority, priorityLabel, identityLabel,
    explanation: otherIdentity ? `This result may refer to a different ${business ? 'business' : 'person'}. Confirm the identity before preparing a request.`
      : topic ? topic[1] : ordinary ? 'The saved search preview was not flagged for a concern. This does not establish that the page is harmless or about you.'
      : 'No recognised topic label is available for this result. Review its context before deciding what to do.',
    priorityExplanation: priority === 'first' ? '“Review first” means the saved automatic score suggests checking this result sooner. It is not a measure of danger or proof of harm.'
      : priority === 'next' ? '“Review next” means the saved automatic score suggests checking this after the results marked “Review first”. It does not confirm harm.'
      : priority === 'identity' ? '“Check identity first” means you should establish who the result refers to before taking action.'
      : '“Review context” means checking the source and deciding whether it is relevant to your request.',
    identityExplanation: `Identity labels are estimates, not verification. Confirm that the page is about ${subject}. The app uses search previews; it has not opened or verified the source page.`,
  };
}
