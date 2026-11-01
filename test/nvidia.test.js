const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNimCompletion, NIM_CHAT_COMPLETIONS } = require('../server/nvidia');

test('NIM call uses the NVIDIA OpenAI-compatible endpoint and configured model', async () => {
  let request;
  const result = await createNimCompletion({
    env: { NVIDIA_API_KEY: 'test-secret', NVIDIA_MODEL: 'openai/gpt-oss-20b' },
    messages: [{ role: 'user', content: 'Hello' }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-oss-20b',
          choices: [{ message: { content: 'Namaste!' } }],
        }),
      };
    },
  });
  assert.equal(request.url, NIM_CHAT_COMPLETIONS);
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
  assert.equal(JSON.parse(request.options.body).model, 'openai/gpt-oss-20b');
  assert.equal(result.model, 'openai/gpt-oss-20b');
  assert.equal(result.content, 'Namaste!');
});

test('NIM adapter returns only the allowlisted portal-change tool call for backend validation', async () => {
  const tools = [{ type: 'function', function: { name: 'propose_portal_change' } }];
  let sent;
  const result = await createNimCompletion({
    env: { NVIDIA_API_KEY: 'test-secret', NVIDIA_MODEL: 'openai/gpt-oss-20b' },
    messages: [{ role: 'user', content: 'Add a task' }],
    tools,
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-oss-20b',
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      name: 'propose_portal_change',
                      arguments: JSON.stringify({
                        entity: 'task',
                        action: 'create',
                        data: { title: 'Confirm venue' },
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
    },
  });
  assert.equal(sent.tools[0].function.name, 'propose_portal_change');
  assert.equal(sent.tool_choice, 'auto');
  assert.deepEqual(result.toolCall, {
    entity: 'task',
    action: 'create',
    data: { title: 'Confirm venue' },
  });
});

test('missing NVIDIA config fails closed without calling the provider', async () => {
  let called = false;
  const result = await createNimCompletion({
    env: {},
    messages: [],
    fetchImpl: async () => {
      called = true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'not_configured');
  assert.equal(called, false);
  const placeholder = await createNimCompletion({
    env: { NVIDIA_API_KEY: 'your_nvidia_api_key', NVIDIA_MODEL: 'openai/gpt-oss-20b' },
    messages: [],
    fetchImpl: async () => {
      called = true;
    },
  });
  assert.equal(placeholder.code, 'not_configured');
  assert.equal(called, false);
});

test('provider auth errors are safe and do not reveal secrets', async () => {
  const result = await createNimCompletion({
    env: { NVIDIA_API_KEY: 'private-test-key', NVIDIA_MODEL: 'test-model' },
    messages: [],
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(result.status, 502);
  assert.equal(result.error.includes('private-test-key'), false);
  assert.match(result.error, /NVIDIA_API_KEY/);
});

test('provider rate limits and timeouts return actionable safe errors', async () => {
  const env = { NVIDIA_API_KEY: 'test', NVIDIA_MODEL: 'test-model' };
  const limited = await createNimCompletion({
    env,
    messages: [],
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(limited.status, 503);
  const timeout = await createNimCompletion({
    env,
    messages: [],
    fetchImpl: async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    },
  });
  assert.equal(timeout.status, 504);
  const bodyTimeout = await createNimCompletion({
    env,
    messages: [],
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        const e = new Error('aborted while reading');
        e.name = 'AbortError';
        throw e;
      },
    }),
  });
  assert.equal(bodyTimeout.status, 504);
});

test('provider invalid model and empty completions never appear successful', async () => {
  const env = { NVIDIA_API_KEY: 'test', NVIDIA_MODEL: 'invalid-model' };
  const invalid = await createNimCompletion({
    env,
    messages: [],
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(invalid.code, 'provider_model');
  const empty = await createNimCompletion({
    env,
    messages: [],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    }),
  });
  assert.equal(empty.code, 'provider_empty_response');
});
