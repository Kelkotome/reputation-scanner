import { describe, it, expect, vi } from 'vitest';
import { callTool, cloudAiEnabled } from '../src/llm.js';
import { expandQueries } from '../src/expand.js';

describe('structured LLM requests and expansion', () => {
  const options = { model: 'test-model', system: 'System instructions', user: 'User content', tool: { name: 'record', input_schema: { type: 'object' } } };
  it('refuses missing keys without a request', async () => {
    const fetchImpl = vi.fn();
    await expect(callTool({ CLOUD_AI_ENABLED: 'true' }, { ...options, fetchImpl })).rejects.toThrow('no_anthropic_key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false', false, true, 'TRUE', 'true '])('blocks cloud requests before fetching unless the flag explicitly opts in (%j)', async flag => {
    const env = { ANTHROPIC_API_KEY: 'test-anthropic-key', OPENAI_API_KEY: 'test-openai-key' };
    if (flag !== undefined) env.CLOUD_AI_ENABLED = flag;
    const fetchImpl = vi.fn(() => { throw new Error('Must remain offline'); });
    expect(cloudAiEnabled(env)).toBe(false);
    await expect(callTool(env, { ...options, fetchImpl })).rejects.toThrow('cloud_ai_disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('requires both explicit opt-in and a supported provider key', () => {
    expect(cloudAiEnabled({ CLOUD_AI_ENABLED: 'true' })).toBe(false);
    expect(cloudAiEnabled({ CLOUD_AI_ENABLED: 'true', OPENAI_API_KEY: 'unused-key' })).toBe(false);
    expect(cloudAiEnabled({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' })).toBe(true);
  });
  it('forces the selected tool, parses its output and accounts for cached input', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ content: [{ type: 'tool_use', name: 'record', input: { ok: true } }], usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 200, output_tokens: 30 } }));
    expect(await callTool({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, { ...options, fetchImpl }))
      .toEqual({ input: { ok: true }, usage: { in: 170, out: 30 } });
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'record' });
    expect(request.messages).toEqual([{ role: 'user', content: 'User content' }]);
  });
  it('surfaces provider failure with a bounded message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('x'.repeat(1000), { status: 429 }));
    await expect(callTool({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, { ...options, fetchImpl })).rejects.toThrow('anthropic_429: ' + 'x'.repeat(300));
  });
  it('accepts scoped expansion queries and rejects unrelated or oversized output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ content: [{ type: 'tool_use', input: { queries: [
      { q: 'Anne Lee complaint', priority: 9 },
      { q: 'Somebody Else fraud', priority: 1 },
      { q: 'Anne Lee ' + 'x'.repeat(130), priority: 1 },
    ] } }] }));
    const result = await expandQueries({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, { full_name: 'Anne Lee' }, ['anne lee'], fetchImpl);
    expect(result.queries).toEqual([{ q: 'Anne Lee complaint', priority: 3, source: 'ai' }]);
  });
  it('expands with business context and drops personal-name word rotations', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ content: [{ type: 'tool_use', input: { queries: [
      { q: 'Green Leaf Studio complaint', priority: 2 },
      { q: 'Leaf Studio Green fraud', priority: 1 },
    ] } }] }));
    const scan = { full_name: 'Green Leaf Studio', context: { subject_type: 'business', website: 'https://greenleaf.example', industry: 'Landscape design', city: 'Tampines', employer: 'Unused Employer', school: 'Unused School' } };
    const result = await expandQueries({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, scan, ['green leaf studio'], fetchImpl);
    expect(result.queries).toEqual([{ q: 'Green Leaf Studio complaint', priority: 2, source: 'ai' }]);
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(JSON.parse(request.messages[0].content)).toMatchObject({ subject_type: 'business', website: scan.context.website, industry: scan.context.industry, city: 'Tampines' });
    expect(request.messages[0].content).not.toMatch(/employer|school/);
    expect(request.system[0].text).toContain('Do not rotate words');
  });
});
