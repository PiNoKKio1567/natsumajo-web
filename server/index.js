// cloudsave —— 一个极小的存档中转：页面 PUT 上来，落到 GitHub 仓库里的一个 JSON 文件。
// 之所以不直接写盘：Render 免费实例的文件系统每次重启/部署都会清空。
const http = require('http');

const PORT = process.env.PORT || 8080;
const TOKEN = (process.env.GH_TOKEN || '').trim();
const REPO = (process.env.REPO || 'PiNoKKio1567/natsumajo-web').trim();
const KEY = (process.env.SAVE_KEY || '').trim();
const ORIGINS = (process.env.ALLOW_ORIGIN || 'https://natsumajo-web.onrender.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// 只有列进去的来源才拿到 CORS 通行证；本机调试（127.0.0.1 / localhost 任意端口）也放行。
function allowOrigin(origin) {
  if (origin && (ORIGINS.includes('*') || ORIGINS.includes(origin))) return origin;
  if (origin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin;
  return ORIGINS[0];
}
const DIR = 'cloudsaves';

const MAX_BODY = 12 * 1024 * 1024;

function gh(method, path, body) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cloudsave',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// 注意：contents API 对 >1MB 的文件返回 content:""，得再用 git/blobs 取一次
// （存档 JSON 是 base64 包的，涨得很快，早就过 1MB 了）。
async function readStore(game) {
  const res = await gh('GET', `/repos/${REPO}/contents/${DIR}/${game}.json`);
  if (res.status === 404) return { sha: null, data: null };
  if (!res.ok) throw new Error(`github read ${res.status}`);
  const j = await res.json();
  let raw;
  if (j.content) {
    raw = Buffer.from(j.content, 'base64').toString('utf8');
  } else {
    const blob = await gh('GET', `/repos/${REPO}/git/blobs/${j.sha}`);
    if (!blob.ok) throw new Error(`github blob ${blob.status}`);
    const bj = await blob.json();
    raw = Buffer.from(bj.content || '', 'base64').toString('utf8');
  }
  return { sha: j.sha, data: JSON.parse(raw || '{}') };
}

async function writeStore(game, sha, data) {
  const body = {
    message: `cloudsave: ${game} @ ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
  };
  if (sha) body.sha = sha;
  const res = await gh('PUT', `/repos/${REPO}/contents/${DIR}/${game}.json`, body);
  return res.ok;
}

function send(res, origin, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': allowOrigin(origin),
    'Access-Control-Allow-Headers': 'content-type, x-save-key',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, req.headers.origin, 204, {});
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(res, req.headers.origin, 200, { ok: true });
    const m = url.pathname.match(/^\/api\/save\/([a-z0-9_-]{1,32})$/);
    if (!m) return send(res, req.headers.origin, 404, { error: 'no such endpoint' });
    if (!KEY || (req.headers['x-save-key'] || '') !== KEY) return send(res, req.headers.origin, 401, { error: 'wrong key' });
    const game = m[1];

    if (req.method === 'GET') {
      const { data } = await readStore(game);
      if (!data) return send(res, req.headers.origin, 404, { error: 'no save yet' });
      return send(res, req.headers.origin, 200, data);
    }

    if (req.method !== 'PUT') return send(res, req.headers.origin, 405, { error: 'use GET or PUT' });

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, req.headers.origin, 413, { error: 'save too large' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { return send(res, req.headers.origin, 400, { error: 'body is not json' }); }
    if (!body || typeof body.files !== 'object') return send(res, req.headers.origin, 400, { error: 'need {files:{name:base64}}' });

    // 乐观并发：读到旧的 sha 就整份重写，冲突时重读一次
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha, data } = await readStore(game);
      const merged = {
        updated: new Date().toISOString(),
        files: Object.assign({}, (data && data.files) || {}, body.files),
      };
      if (await writeStore(game, sha, merged)) return send(res, req.headers.origin, 200, { updated: merged.updated, files: Object.keys(merged.files) });
      await new Promise((r) => setTimeout(r, 150));
    }
    return send(res, req.headers.origin, 502, { error: 'github write kept failing' });
  } catch (e) {
    return send(res, req.headers.origin, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => console.log(`cloudsave on ${PORT}, repo ${REPO}`));
