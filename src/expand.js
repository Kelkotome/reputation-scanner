// One cheap Claude call per scan: localised reputation query variants from the user's context.

import { callTool } from './llm.js';
import { mentionsName, isBusinessSubject } from './text.js';

const SYSTEM = `You generate Google search queries a person can use to audit their OWN online reputation.
Given their name and context, produce up to 20 extra queries that surface scam/fraud accusations, crime or court mentions, call-outs, defamation, exposed personal information, harassment, and negative reviews or forum threads.
Cover: name spellings and romanisations (e.g. Chinese/Malay name orders, nicknames), local languages and slang for the user's country (e.g. Singlish, Malay, Chinese), employer/school/username combinations, and local forums/review sites.
Every query MUST contain the person's name, an alias, or a username. Do not generate queries about sexual or intimate content. Keep queries short, like real searches.
priority: 1 = scam/crime/court, 2 = accusation/defamation, 3 = personal info/harassment/reviews.`;

const BUSINESS_SYSTEM = `You generate Google search queries an authorised representative can use to audit their business's online reputation.
Given the business name and context, produce up to 20 extra queries about scam/fraud accusations, court mentions, call-outs, defamation, complaints, and negative reviews or forum threads.
Use explicit business aliases, local languages, location, website, industry and business handles to distinguish similarly named businesses. Do not rotate words as though the business name were a person's name. Do not use employer or school details.
Every query MUST contain the business name, a supplied alias, or a business handle. Do not generate queries about sexual or intimate content or seek private personal information. Keep queries short, like real searches.
priority: 1 = scam/crime/court, 2 = accusation/defamation, 3 = complaints/reviews.`;

const TOOL = {
  name: 'record_queries',
  description: 'Record the extra search queries.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: { q: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 3 } },
          required: ['q', 'priority'],
        },
      },
    },
    required: ['queries'],
  },
};

export async function expandQueries(env, scan, forms, fetchImpl) {
  const c = scan.context || {};
  const business = isBusinessSubject(scan);
  const user = JSON.stringify({
    name: scan.full_name, aliases: scan.variants || [], country: c.country || '',
    city: c.city || '', usernames: c.usernames || [],
    ...(business
      ? { subject_type: 'business', website: c.website || '', industry: c.industry || '' }
      : { employer: c.employer || '', school: c.school || '' }),
    languages: c.languages || [],
  });
  const { input, usage } = await callTool(env, {
    model: env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001', system: business ? BUSINESS_SYSTEM : SYSTEM, user, tool: TOOL, maxTokens: 900, fetchImpl,
  });
  const queries = (input?.queries || [])
    .filter((x) => x && typeof x.q === 'string' && x.q.length <= 120)
    .filter((x) => mentionsName(x.q, forms)).slice(0, 20)
    .map((x) => ({ q: x.q.trim(), priority: Math.min(3, Math.max(1, x.priority | 0 || 2)), source: 'ai' }));
  return { queries, usage };
}
