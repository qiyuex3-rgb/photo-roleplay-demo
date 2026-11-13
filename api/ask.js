// 把前端的请求转发给任意 OpenAI 兼容的模型接口（/chat/completions）。
// Key 只从环境变量读取，绝不写进代码或前端。
const BASE = (process.env.GATEWAY_BASE_URL || '').replace(/\/+$/, '');   // 例如 https://api.example.com/v1
const MODEL = process.env.GATEWAY_MODEL || '';                           // 需要支持图片输入的模型
const PER_IP_LIMIT = Number(process.env.PER_IP_LIMIT || 40);   // 每个 IP 每 10 分钟的调用上限
const WINDOW_MS = 10 * 60 * 1000;
let effortRejected = false;                                    // 模型不接受推理档位参数时记住，之后不再带它，省一次往返
const hits = new Map();                                        // 进程内计数，实例重启会清零，只是粗略防刷

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_IP_LIMIT;
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const tries = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { return JSON.parse(t.trim()); } catch (_) {} }
  return null;
}

async function callGateway(payload) {
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GATEWAY_KEY },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  return { status: r.status, text };
}

module.exports = async (req, res) => {
  const ACCESS = process.env.ACCESS_CODE || '';
  // GET 只返回各项是否已配置（true/false），不返回任何值，方便排查环境变量
  if (req.method === 'GET') return res.status(200).json({ needCode: !!ACCESS, configured: { GATEWAY_KEY: !!process.env.GATEWAY_KEY, GATEWAY_BASE_URL: !!BASE, GATEWAY_MODEL: !!MODEL } });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.GATEWAY_KEY || !BASE || !MODEL) return res.status(500).json({ error: 'not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return res.status(400).json({ error: 'invalid_request' });
  if (ACCESS && body.code !== ACCESS) return res.status(401).json({ error: 'unauthorized' });
  if (body.prompt.length > 30000) return res.status(413).json({ error: 'too_large' });

  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (limited(ip)) return res.status(429).json({ error: 'rate_limited' });

  let content = body.prompt;
  if (body.image != null) {
    if (typeof body.image !== 'string' || !/^data:image\/(jpeg|png|webp|gif);base64,/.test(body.image)) return res.status(400).json({ error: 'image_rejected' });
    if (body.image.length > 4200000) return res.status(413).json({ error: 'too_large' });
    content = [{ type: 'text', text: body.prompt }, { type: 'image_url', image_url: { url: body.image } }];
  }

  const payload = { model: MODEL, messages: [{ role: 'user', content }], max_tokens: 4000 };
  const effort = process.env.REASONING_EFFORT || (body.effort === 'medium' ? 'medium' : 'low');
  if (effort !== 'none' && !effortRejected) payload.reasoning_effort = effort;

  try {
    const t0 = Date.now();
    let out = await callGateway(payload);
    if (out.status === 400 && payload.reasoning_effort) {       // 有的模型不接受推理档位参数，去掉再试一次
      delete payload.reasoning_effort;
      effortRejected = true;
      out = await callGateway(payload);
    }
    if (out.status !== 200) {
      console.error('gateway error', out.status, out.text.slice(0, 500));
      if (/budget_exceeded/.test(out.text)) return res.status(402).json({ error: 'budget_exceeded' });
      if (out.status === 429) return res.status(429).json({ error: 'rate_limited' });
      return res.status(502).json({ error: 'upstream_error' });
    }
    let j; try { j = JSON.parse(out.text); } catch (_) { j = null; }
    let text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (Array.isArray(text)) text = text.map(p => (p && p.text) || '').join('');
    const data = parseJson(text);
    if (!data || typeof data !== 'object') {
      console.error('unparseable reply', String(text).slice(0, 500));
      return res.status(502).json({ error: 'invalid_json' });
    }
    const u = (j && j.usage) || {};
    return res.status(200).json({ data, model: MODEL, gatewayMs: Date.now() - t0, outTokens: u.completion_tokens || null, inTokens: u.prompt_tokens || null });
  } catch (e) {
    console.error('gateway call failed', e && e.message);
    return res.status(502).json({ error: 'upstream_error' });
  }
};
