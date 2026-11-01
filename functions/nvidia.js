const NIM_CHAT_COMPLETIONS = 'https://integrate.api.nvidia.com/v1/chat/completions';
const placeholderKeys = new Set(['your_nvidia_api_key', 'your_api_key', 'replace_me', 'replace-with-your-api-key']);
function isNimConfigured(env = process.env) {
  const key = env.NVIDIA_API_KEY?.trim();
  return Boolean(key && env.NVIDIA_MODEL?.trim() && !placeholderKeys.has(key.toLowerCase()));
}

async function createNimCompletion({ messages, tools, env = process.env, fetchImpl = fetch, timeoutMs = 40000 }) {
  const apiKey = env.NVIDIA_API_KEY?.trim();
  const model = env.NVIDIA_MODEL?.trim();
  if (!isNimConfigured(env)) {
    return { ok: false, status: 503, code: 'not_configured', error: 'AI chat is not configured. Set NVIDIA_API_KEY and NVIDIA_MODEL in the backend environment, then restart the server.' };
  }
  let response;
  try {
    response = await fetchImpl(NIM_CHAT_COMPLETIONS, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model, messages, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}), temperature: 0.5, top_p: 1, max_tokens: 2048, stream: false }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, status: 504, code: 'provider_timeout', error: 'NVIDIA NIM took too long to respond. Please retry.' };
    }
    return { ok: false, status: 503, code: 'provider_unavailable', error: 'Could not reach NVIDIA NIM. Check the server connection and retry.' };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return { ok: false, status: 502, upstreamStatus: response.status, code: 'provider_auth', error: 'NVIDIA NIM rejected the configured API key. Check NVIDIA_API_KEY on the server.' };
    if (response.status === 429) return { ok: false, status: 503, upstreamStatus: response.status, code: 'provider_rate_limit', error: 'NVIDIA NIM is rate limiting requests. Please wait a moment and retry.' };
    if (response.status === 404) return { ok: false, status: 502, upstreamStatus: response.status, code: 'provider_model', error: 'NVIDIA NIM could not find an inference endpoint for this model and API key. Check NVIDIA_MODEL and enable or regenerate access to this model in NVIDIA Build.' };
    if (response.status === 410) return { ok: false, status: 502, upstreamStatus: response.status, code: 'provider_model_retired', error: 'This NVIDIA model endpoint has been retired. Select a currently available NVIDIA NIM model in NVIDIA_MODEL.' };
    if (response.status === 400) return { ok: false, status: 502, upstreamStatus: response.status, code: 'provider_model', error: 'NVIDIA NIM rejected the request. Check the model API reference and supported request options.' };
    return { ok: false, status: 502, upstreamStatus: response.status, code: 'provider_error', error: 'NVIDIA NIM could not complete this request. Please retry.' };
  }
  let payload;
  try { payload = await response.json(); }
  catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: false, status: 504, code: 'provider_timeout', error: 'NVIDIA NIM took too long to respond. Please retry.' };
    return { ok: false, status: 502, code: 'provider_invalid_response', error: 'NVIDIA NIM returned an unreadable response.' };
  }
  const content = payload?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : Array.isArray(content) ? content.map(x => x?.text || '').join('').trim() : '';
  const call = payload?.choices?.[0]?.message?.tool_calls?.find(item => item?.type === 'function' && item?.function?.name === 'propose_portal_change');
  let toolCall = null;
  if (call && typeof call.function.arguments === 'string') {
    try { toolCall = JSON.parse(call.function.arguments); } catch { /* invalid tool arguments are ignored and never applied */ }
  }
  if (!text && !toolCall) return { ok: false, status: 502, code: 'provider_empty_response', error: 'NVIDIA NIM returned an empty response. Please retry.' };
  return { ok: true, content: text, toolCall, model: typeof payload.model === 'string' ? payload.model : model };
}

module.exports = { createNimCompletion, isNimConfigured, NIM_CHAT_COMPLETIONS };
