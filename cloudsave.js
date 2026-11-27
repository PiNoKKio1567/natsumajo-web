// cloudsave.js —— 把存档放到云端，并在多台设备之间同步。
//
// 页面只要在加载它之前给出配置：
//   window.CLOUDSAVE = { url, game, dir, files: ['progress.json', ...] }
// dir 是游戏在 /userfs 下的存档目录，files 是同步哪些文件。
//
// 为什么不是「直接写服务器磁盘」：Render 免费实例每回重启都把文件系统清掉，存档得落到
// 仓库里。中转服务记得住「谁最后改的」，这里是它的客户端一半：
//   · 启动时先拉一次（云端更新过就覆盖本地）
//   · 玩的时候每 45 秒看一次本地有没有变，变了就推上去
//   · 推之前先问一句云端是不是比自己新，是就改拉不推 —— 免得把另一台设备的进度盖掉
(function () {
  const cfg = window.CLOUDSAVE;
  if (!cfg || !cfg.url) return;

  const KEY_ITEM = 'cloudsave.key';
  const APPLIED = 'cloudsave.applied.' + cfg.game; // 云端哪一版已经落到本地
  const SENT = 'cloudsave.sent.' + cfg.game;       // 本地哪一版已经推上去了

  const dir = String(cfg.dir).replace(/\/$/, '');
  const files = cfg.files || [];
  const key = () => localStorage.getItem(KEY_ITEM) || '';

  const toB64 = (u8) => {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  };
  const fromB64 = (str) => {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('/userfs');
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('FILE_DATA')) req.result.createObjectStore('FILE_DATA');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(db, path) {
    return new Promise((resolve) => {
      const g = db.transaction('FILE_DATA', 'readonly').objectStore('FILE_DATA').get(path);
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => resolve(null);
    });
  }

  function idbPut(db, path, value) {
    return new Promise((resolve) => {
      const tx = db.transaction('FILE_DATA', 'readwrite');
      tx.objectStore('FILE_DATA').put(value, path);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  }

  async function readLocal(name) {
    try {
      const db = await idbOpen();
      const rec = await idbGet(db, dir + '/' + name);
      if (!rec || !rec.contents) return null;
      return { bytes: new Uint8Array(rec.contents), mtime: new Date(rec.timestamp).getTime() };
    } catch (e) { return null; }
  }

  async function writeLocal(name, bytes, when) {
    const stampAt = when ? new Date(when) : new Date();
    const db = await idbOpen();
    const path = dir + '/' + name;
    const parts = path.split('/').filter(Boolean);
    let at = '';
    for (let i = 0; i < parts.length - 1; i++) {
      at += '/' + parts[i];
      if (!(await idbGet(db, at))) {
        await idbPut(db, at, { mode: 16893, timestamp: stampAt });
      }
    }
    const copy = new Int8Array(bytes.length);
    copy.set(bytes);
    await idbPut(db, path, { mode: 33206, timestamp: stampAt, contents: copy });
  }

  async function stamp() {
    const bits = [];
    for (const name of files) {
      const rec = await readLocal(name);
      bits.push(rec ? name + ':' + rec.mtime + ':' + rec.bytes.length : name + ':-');
    }
    return bits.join('|');
  }

  // 本地这几个存档里最新的一次修改时间（毫秒）。本地比云端新的时候，
  // 不能拿云端去盖它 —— 那是主人刚存下来的进度。
  async function newestLocalTs() {
    let best = 0;
    for (const name of files) {
      const rec = await readLocal(name);
      const ts = rec && rec.mtime ? rec.mtime : 0;
      if (ts > best) best = ts;
    }
    return best;
  }

  async function call(method, body) {
    const headers = { 'content-type': 'application/json' };
    if (key()) headers['x-save-key'] = key();
    return fetch(cfg.url + '/api/save/' + cfg.game, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function pull(engine) {
    const res = await call('GET');
    if (res.status === 401) { const e = new Error('云存档口令不对'); e.code = 'key'; throw e; }
    if (!res.ok) return 'no-cloud';
    const data = await res.json();
    if (!data || !data.files) return 'empty';
    if (localStorage.getItem(APPLIED) === data.updated) return 'same';
    const cloudTs = Date.parse(data.updated) || 0;
    const localTs = await newestLocalTs();
    // 只有「这台设备以前同步过」时才比较新旧：刚导入的种子文件时间也是新的，不能算数
    const synced = !!localStorage.getItem(APPLIED);
    // 本地有比云端更新的存档（刚存的），先别盖，交给上层推上去
    if (synced && localTs && cloudTs && localTs > cloudTs + 60000) return 'local-newer';
    let n = 0;
    for (const name of files) {
      const enc = data.files[name];
      if (!enc) continue;
      const bytes = fromB64(enc);
      if (engine) {
        try { await engine.preloadFile(bytes.buffer, dir + '/' + name); } catch (e) { console.warn('preload', name, e); }
      }
      await writeLocal(name, bytes, cloudTs || undefined);
      n++;
    }
    localStorage.setItem(APPLIED, data.updated);
    localStorage.setItem(SENT, await stamp()); // 刚拉下来的就是「已经同步过」的状态
    return 'pulled ' + n;
  }

  async function push() {
    const now = await stamp();
    if (!now || now === localStorage.getItem(SENT)) return 'idle';
    const res = await call('GET');
    if (res.status === 401) return 'key';
    if (res.ok) {
      const data = await res.json().catch(() => null);
      // 云端有东西却没读到版本号 = 服务端读坏了，宁可这次不推，也不能拿本地旧档盖上去
      if (!data || !data.updated) return 'bad-remote';
      // 云端比本地新（或本地这台还没拉过）就先让上层去拉，避免把另一台设备的进度盖掉
      if (data.updated !== localStorage.getItem(APPLIED)) {
        const synced = !!localStorage.getItem(APPLIED);
        const cloudTs = Date.parse(data.updated) || 0;
        const localTs = await newestLocalTs();
        // 本地更新（且这台设备同步过）就直接推，别被云端的旧版本挡住
        if (!(synced && localTs && cloudTs && localTs > cloudTs + 60000)) return 'remote-newer';
      }
    } else if (res.status !== 404) {
      return 'no-cloud ' + res.status;
    }
    const out = {};
    for (const name of files) {
      const rec = await readLocal(name);
      if (rec) out[name] = toB64(rec.bytes);
    }
    if (!Object.keys(out).length) return 'nothing-local';
    const put = await call('PUT', { files: out });
    if (!put.ok) return 'put-failed ' + put.status;
    const done = await put.json().catch(() => null);
    if (done && done.updated) localStorage.setItem(APPLIED, done.updated);
    localStorage.setItem(SENT, now);
    return 'pushed';
  }

  window.CloudSave = {
    hasKey: () => !!key(),
    setKey: (k) => localStorage.setItem(KEY_ITEM, k),
    clearKey: () => localStorage.removeItem(KEY_ITEM),
    async checkKey() {
      try {
        const res = await call('GET');
        if (res.status === 401) return 'wrong';
        if (res.ok || res.status === 404) return 'ok';
        return 'offline';
      } catch (e) { return 'offline'; }
    },
    pull,
    push,
    newestLocalTs,
    start(engine) {
      setInterval(() => {
        push().then((r) => {
          if (r === 'remote-newer') return pull(engine);
          if (r === 'local-newer') return push();
          return null;
        }).catch(() => {});
      }, 8000);
      window.addEventListener('pagehide', () => { push().catch(() => {}); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') push().catch(() => {});
      });
    },
  };
})();
