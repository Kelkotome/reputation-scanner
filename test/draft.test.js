import { beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('../src/llm.js', async importOriginal => ({ ...await importOriginal(), callTool: vi.fn() }));
vi.mock('../src/budget.js', () => ({ recordUsage: vi.fn() }));
import { callTool } from '../src/llm.js';
import { recordUsage } from '../src/budget.js';
import { draftRequest } from '../src/draft.js';

const scan = { id: 'scan-1', full_name: 'Alex Example', email: 'alex@example.com', is_minor: 0 };
const hit = { id: 2, url: 'https://website.com/post', category: 'scam_fraud', match_confidence: 0.8 };
function env(key = '') {
  const run = vi.fn(async () => ({ meta: { last_row_id: 3 } }));
  const bind = vi.fn(() => ({ run }));
  return { CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: key, DB: { prepare: vi.fn(() => ({ bind })) }, bind, run };
}
beforeEach(() => vi.clearAllMocks());

describe('draftRequest', () => {
  const business = { ...scan, full_name: 'Green Leaf Studio', context: { subject_type: 'business', representative_name: 'Ari Tan' } };
  it('saves business correspondence locally with a representative signature and explicit copyright ownership', async () => {
    const e = { ...env('configured-key'), CLOUD_AI_ENABLED: 'false' };
    const draft = await draftRequest(e, business, hit, 'inaccurate');
    expect(draft.body).toContain('requesting removal of the identified claim about Green Leaf Studio');
    expect(draft.body).toContain('Ari Tan\nOn behalf of Green Leaf Studio');
    const copyright = await draftRequest(e, business, { ...hit, owns_content: true }, 'copyright');
    expect(copyright.body).toContain('Green Leaf Studio owns the work');
    expect(copyright.body).toContain('Electronic signature: Ari Tan');
    expect(copyright.body).not.toContain('I am the owner');
    await expect(draftRequest(e, business, hit, 'copyright')).rejects.toThrow('template_not_eligible');
    expect(callTool).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
  it('refuses business personal-info drafts and drafts without a representative before saving', async () => {
    const e = env();
    await expect(draftRequest(e, business, { ...hit, category: 'doxxing_personal_info' }, 'personal_info')).rejects.toThrow('template_not_eligible');
    await expect(draftRequest(e, { ...business, context: { subject_type: 'business' } }, hit, 'inaccurate')).rejects.toThrow('representative_name_required');
    expect(e.run).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
  it('rejects model output that omits the business representative signature', async () => {
    const e = env('test-key');
    callTool.mockResolvedValue({ input: { subject: 'Request to review', body: `Please review [statement] at ${hit.url}. My statements are accurate to the best of my knowledge. ${business.full_name} ${business.email}` }, usage: { in: 10, out: 10 } });
    const draft = await draftRequest(e, business, hit, 'inaccurate');
    expect(draft.source).toBe('template');
    expect(draft.body).toContain('Ari Tan\nOn behalf of Green Leaf Studio');
  });
  it('saves a plain template when no API key exists', async () => {
    const e = env();
    const draft = await draftRequest(e, scan, hit, 'inaccurate', { form: 'https://website.com/report' });
    expect(draft.id).toBe(3);
    expect(draft.source).toBe('template');
    expect(draft.body).toContain(hit.url);
    expect(e.bind).toHaveBeenCalledWith(scan.id, hit.id, 'inaccurate', JSON.stringify(draft.channel), draft.subject, draft.body, expect.any(Number));
    expect(callTool).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false'])('saves a local draft with configured keys when cloud AI is disabled (%j)', async flag => {
    const e = { ...env('test-anthropic-key'), OPENAI_API_KEY: 'test-openai-key' };
    if (flag === undefined) delete e.CLOUD_AI_ENABLED;
    else e.CLOUD_AI_ENABLED = flag;
    const draft = await draftRequest(e, scan, hit, 'inaccurate');
    expect(draft.source).toBe('template');
    expect(draft.body).toContain(hit.url);
    expect(draft.body).toContain(scan.full_name);
    expect(draft.body).toContain(scan.email);
    expect(e.run).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
  it('rejects sensitive content, minor copyright requests and ineligible same-name letters', async () => {
    const e = env('secret');
    await expect(draftRequest(e, scan, { ...hit, category: 'sensitive_intimate', owns_content: true }, 'copyright')).rejects.toThrow('template_not_eligible');
    await expect(draftRequest(e, { ...scan, is_minor: 1 }, { ...hit, owns_content: true }, 'copyright')).rejects.toThrow('template_not_eligible');
    await expect(draftRequest(e, scan, { ...hit, match_confidence: 0.2 }, 'same_name')).rejects.toThrow('template_not_eligible');
    expect(callTool).not.toHaveBeenCalled();
    expect(e.run).not.toHaveBeenCalled();
  });
  it('saves valid model output and records paid usage', async () => {
    const e = env('secret');
    const input = { subject: 'Request to review a statement', body: `Please review [statement] at ${hit.url}. [Explain the issue]. Please correct it if appropriate. I confirm my statements are accurate to the best of my knowledge.\n${scan.full_name}\n${scan.email}` };
    callTool.mockResolvedValue({ input, usage: { in: 100, out: 40 } });
    const result = await draftRequest(e, scan, hit, 'inaccurate');
    expect(result).toMatchObject({ ...input, source: 'claude' });
    expect(recordUsage).toHaveBeenCalledWith(e, e.DB, scan.id, { inTok: 100, outTok: 40 });
  });
  it('retains the plain template when model output is malformed or threatens legal action, but counts usage', async () => {
    const e = env('secret');
    callTool.mockResolvedValue({ input: { subject: 'Threat', body: `I will sue you. ${hit.url} ${scan.full_name} ${scan.email} accurate to the best of my knowledge` }, usage: { in: 100, out: 50 } });
    expect((await draftRequest(e, scan, hit, 'inaccurate')).source).toBe('template');
    expect(recordUsage).toHaveBeenCalledOnce();
  });
  it('falls back if the model is unavailable', async () => {
    callTool.mockRejectedValue(new Error('offline'));
    expect((await draftRequest(env('secret'), scan, hit, 'inaccurate')).source).toBe('template');
  });
  it('requires placeholders for unknown evidence, not a model-completed claim', async () => {
    callTool.mockResolvedValue({ input: { subject: 'Please remove', body: `The claim is false. Please remove ${hit.url}. My statements are accurate to the best of my knowledge. ${scan.full_name} ${scan.email}` }, usage: { in: 100, out: 40 } });
    expect((await draftRequest(env('secret'), scan, hit, 'inaccurate')).source).toBe('template');
  });
  it('aborts a stalled drafting API after eight seconds and saves the fallback', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    callTool.mockImplementation((e, options) => options.fetchImpl('https://api.anthropic.com/v1/messages', {}));
    try {
      const result = draftRequest(env('secret'), scan, hit, 'inaccurate');
      await vi.advanceTimersByTimeAsync(8000);
      expect((await result).source).toBe('template');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
