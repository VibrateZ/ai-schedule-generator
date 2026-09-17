function endpointFor(baseUrl) {
  const value = baseUrl.replace(/\/+$/, '');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('API 地址必须使用 HTTPS；本地 localhost 可使用 HTTP');
  }
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function extractJson(content) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('AI 未返回可解析的 JSON');
  }
}

async function requestChat(config, messages, temperature = 0.2, options = {}) {
  const endpoint = endpointFor(config.baseUrl);
  if (!config.apiKey) throw new Error('请输入 API Key');
  if (!config.model) throw new Error('请输入模型名称');
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 120000;
  const deadline = Date.now() + timeoutMs;
  const body = {
    model: config.model,
    messages,
    temperature,
    response_format: { type: 'json_object' },
  };

  const request = async () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`API 请求超时（${Math.ceil(timeoutMs / 1000)} 秒），请检查服务商状态或稍后重试`);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`API 请求超时（${Math.ceil(timeoutMs / 1000)} 秒），请检查服务商状态或稍后重试`));
      }, remainingMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          return { response, text: await response.text() };
        })(),
        timeout,
      ]);
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`API 请求超时（${Math.ceil(timeoutMs / 1000)} 秒），请检查服务商状态或稍后重试`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await request();
  if (!result.response.ok && [400, 422].includes(result.response.status)) {
    delete body.response_format;
    result = await request();
  }
  if (!result.response.ok) {
    throw new Error(`API 请求失败（${result.response.status}）：${result.text.slice(0, 500)}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.text);
  } catch {
    throw new Error('API 响应不是有效 JSON');
  }
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 响应中缺少 choices[0].message.content');
  return extractJson(content);
}

module.exports = { endpointFor, extractJson, requestChat };
