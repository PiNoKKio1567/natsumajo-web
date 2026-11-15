# 部署到 Render（外网可访问）

## 为什么不能直接把整个文件夹传上去

游戏本体 `game.pck` 是 **553 MB**。GitHub 单文件上限 100 MB，Git LFS 免费额度只有 1 GB 流量
（够下载不到两次），Render 也不支持 LFS 拉取。所以：

- **小文件**（index.html、godot.js、godot.wasm、worklet、portable/）→ 放进 Git 仓库
- **大文件 game.pck** → 挂成同一个仓库的 **GitHub Release 附件**（单个最大 2 GB、不限流量）
- Render 构建时用 `curl` 把它下载到发布目录

`render.yaml` 已经写好了构建命令、静态发布目录和三个必需响应头。

## 为什么要那三个响应头

Godot 的多线程网页版要用 `SharedArrayBuffer`，浏览器只在「跨源隔离」的页面里才给，
而跨源隔离要求 `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp`。少了这两个头，页面会卡在加载，
或者直接报缺少功能。Render 默认不发这两个头，所以必须写在 `render.yaml` 里。

## 步骤

1. 建一个 GitHub 仓库（public 或 private 都行），把这些文件传上去：
   `index.html`、`godot.js`、`godot.wasm`、`godot.audio.worklet.js`、
   `godot.audio.position.worklet.js`、`test-sound.html`、
   `portable/config.json`、`portable/save_00.json`、`render.yaml`、`.gitignore`

2. 在这个仓库的 **Releases → Draft a new release**，tag 用 `v1`，
   把本地 `site/game.pck` 拖进去当附件，发布。

3. 复制那个附件的下载地址，形如：
   `https://github.com/<你>/<仓库>/releases/download/v1/game.pck`

4. Render → New → **Static Site** → 选这个仓库 → 语言/框架随便（我们用 render.yaml）。
   在 Environment 里加变量 `PCK_URL` = 第 3 步的地址。

5. Deploy。构建时会把 553 MB 拉下来（几分钟），之后发布目录里就有 `game.pck` 了。

6. 打开 Render 给的 `https://xxx.onrender.com`，等它加载完，点「开始」。


## 如果不用 render.yaml（在网页仪表盘里手动建）

Static Site → Build Command 填：

```
(curl -fL -o game.pck "$PCK_URL" || wget -qO game.pck "$PCK_URL") && ls -l game.pck
```

Publish Directory 填 `.`，环境变量 `PCK_URL` 填那个 Release 附件地址，
然后在 Settings → Headers 加这三条（路径都填 `/*`）：

| Name | Value |
|---|---|
| Cross-Origin-Opener-Policy | same-origin |
| Cross-Origin-Embedder-Policy | require-corp |
| Cross-Origin-Resource-Policy | same-origin |

`game.pck` 和 `godot.wasm` 各再加一条 `Cache-Control: public, max-age=31536000, immutable`，
省得每次重下 550 MB。

## 注意

- 首次访问要下 550 MB，取决于你的网络，可能要等一阵；之后浏览器会缓存
  （`game.pck` 设了 immutable）。
- Render 免费静态站点有每月 100 GB 流量额度，够用，但别到处宣传。
- 存档仍然存在**访客自己的浏览器**里（IndexedDB），不跟着网址走，换设备就是新档。
- 想让网址不那么"谁都能开"，可以在 `index.html` 里把 `ACCESS_CODE` 设成一句话，
  打开页面时先要输这个口令。
