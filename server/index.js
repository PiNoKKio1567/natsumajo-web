// cloudsave —— 一个极小的存档中转：页面 PUT 上来，落到 GitHub 仓库里的一个 JSON 文件。
// 之所以不直接写盘：Render 免费实例的文件系统每次重启/部署都会清空。
const http = require('http');

const PORT = process.env.PORT || 8080;
const TOKEN = (process.env.GH_TOKEN || '').trim();
const REPO = (process.env.REPO || 'PiNoKKio1567/natsumajo-web').trim();
const KEY = (process.env.SAVE_KEY || '').trim();
const ORIGIN = (process.env.ALLOW_ORIGIN || 'https://natsumajo-web.onrender.com').trim();
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

async function readStore(game) {
  const res = await gh('GET', `/repos/${REPO}/contents/${DIR}/${game}.json`);
  if (res.status === 404) return { sha: null, data: null };
  if (!res.ok) throw new Error(`github read ${res.status}`);
  const j = await res.json();
  const raw = Buffer.from(j.content || '', 'base64').toString('utf8');
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

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'content-type, x-save-key',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    const m = url.pathname.match(/^\/api\/save\/([a-z0-9_-]{1,32})$/);
    if (!m) return send(res, 404, { error: 'no such endpoint' });
    if (!KEY || (req.headers['x-save-key'] || '') !== KEY) return send(res, 401, { error: 'wrong key' });
    const game = m[1];

    if (req.method === 'GET') {
      const { data } = await readStore(game);
      if (!data) return send(res, 404, { error: 'no save yet' });
      return send(res, 200, data);
    }

    if (req.method !== 'PUT') return send(res, 405, { error: 'use GET or PUT' });

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, 413, { error: 'save too large' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { return send(res, 400, { error: 'body is not json' }); }
    if (!body || typeof body.files !== 'object') return send(res, 400, { error: 'need {files:{name:base64}}' });

    // 乐观并发：读到旧的 sha 就整份重写，冲突时重读一次
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha, data } = await readStore(game);
      const merged = {
        updated: new Date().toISOString(),
        files: Object.assign({}, (data && data.files) || {}, body.files),
      };
      if (await writeStore(game, sha, merged)) return send(res, 200, { updated: merged.updated, files: Object.keys(merged.files) });
      await new Promise((r) => setTimeout(r, 150));
    }
    return send(res, 502, { error: 'github write kept failing' });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => console.log(`cloudsave on ${PORT}, repo ${REPO}`));
