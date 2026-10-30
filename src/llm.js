// Minimal Anthropic Messages API client with forced tool output (structured JSON) and usage reporting.

// Keys alone must never opt sensitive scan data into cloud processing.
export const cloudAiEnabled = env => env.CLOUD_AI_ENABLED === 'true' && Boolean(env.ANTHROPIC_API_KEY);

export async function callTool(env, { model, system, user, tool, maxTokens = 1500, fetchImpl = fetch }) {
  if (env.CLOUD_AI_ENABLED !== 'true') throw new Error('cloud_ai_disabled');
  if (!env.ANTHROPIC_API_KEY) throw new Error('no_anthropic_key');
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // cache_control lets repeated scans reuse the system prompt once it passes the model's cache minimum.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anthropic_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  const u = data.usage || {};
  return {
    input: block ? block.input : null,
    usage: {
      in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1,
      out: u.output_tokens || 0,
    },
  };
}
