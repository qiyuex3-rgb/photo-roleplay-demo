// Cloudflare Pages Functions 版本的后端，逻辑与 api/ask.js（Vercel 版）一致。
// 把前端请求转发给任意 OpenAI 兼容的模型接口；Key 只从环境变量读取。
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();          // 进程内计数，只能粗略防刷
let effortRejected = false;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

function limited(ip, max) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
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

function conf(env) {
  return {
    key: env.GATEWAY_KEY || '',
    base: (env.GATEWAY_BASE_URL || '').replace(/\/+$/, ''),
    model: env.GATEWAY_MODEL || '',
    access: env.ACCESS_CODE || '',
    perIp: Number(env.PER_IP_LIMIT || 40),
    effort: env.REASONING_EFFORT || '',
  };
}

export async function onRequestGet({ env }) {
  const c = conf(env);
  return json({ needCode: !!c.access, configured: { GATEWAY_KEY: !!c.key, GATEWAY_BASE_URL: !!c.base, GATEWAY_MODEL: !!c.model } });
}

export async function onRequestPost({ request, env }) {
  const c = conf(env);
  if (!c.key || !c.base || !c.model) return json({ error: 'not_configured' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { body = null; }
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return json({ error: 'invalid_request' }, 400);
  if (c.access && body.code !== c.access) return json({ error: 'unauthorized' }, 401);
  if (body.prompt.length > 30000) return json({ error: 'too_large' }, 413);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (limited(ip, c.perIp)) return json({ error: 'rate_limited' }, 429);

  let content = body.prompt;
  if (body.image != null) {
    if (typeof body.image !== 'string' || !/^data:image\/(jpeg|png|webp|gif);base64,/.test(body.image)) return json({ error: 'image_rejected' }, 400);
    if (body.image.length > 4200000) return json({ error: 'too_large' }, 413);
    content = [{ type: 'text', text: body.prompt }, { type: 'image_url', image_url: { url: body.image } }];
  }

  const payload = { model: c.model, messages: [{ role: 'user', content }], max_tokens: 4000 };
  const effort = c.effort || (body.effort === 'medium' ? 'medium' : 'low');
  if (effort !== 'none' && !effortRejected) payload.reasoning_effort = effort;

  const call = async () => {
    const r = await fetch(c.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
      body: JSON.stringify(payload),
    });
    return { status: r.status, text: await r.text() };
  };

  try {
    const t0 = Date.now();
    let out = await call();
    if (out.status === 400 && payload.reasoning_effort) {
      delete payload.reasoning_effort;
      effortRejected = true;
      out = await call();
    }
    if (out.status !== 200) {
      console.error('gateway error', out.status, out.text.slice(0, 500));
      if (/budget_exceeded/.test(out.text)) return json({ error: 'budget_exceeded' }, 402);
      if (out.status === 429) return json({ error: 'rate_limited' }, 429);
      return json({ error: 'upstream_error' }, 502);
    }
    let j; try { j = JSON.parse(out.text); } catch (_) { j = null; }
    let text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (Array.isArray(text)) text = text.map(p => (p && p.text) || '').join('');
    const data = parseJson(text);
    if (!data || typeof data !== 'object') {
      console.error('unparseable reply', String(text).slice(0, 500));
      return json({ error: 'invalid_json' }, 502);
    }
    const u = (j && j.usage) || {};
    return json({ data, model: c.model, gatewayMs: Date.now() - t0, outTokens: u.completion_tokens || null, inTokens: u.prompt_tokens || null });
  } catch (e) {
    console.error('gateway call failed', e && e.message);
    return json({ error: 'upstream_error' }, 502);
  }
}
