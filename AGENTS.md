# AGENTS.md · 项目交接记忆

> 面向后续接手的 AI 编程助手 / 工程师。先读本文，再按需查阅 `docs/` 下的详细文档。
> 本文记录的是「代码里看不出来、但踩过坑」的约定与背景，改动前请先确认相关条目。

---

## 1. 项目是什么

**大屏聚合平台（TV Show Center）**：面向小米电视 / Android TV 的大屏展示应用。

- **服务端**（`server/`，Node.js）：页面列表与配置的唯一数据源、反向代理、兼容转译、极速截图、摄像头 MJPEG、多设备互控控制通道、**素材上墙（上传/转换/播放页）**。
- **电视端 APK**（`app/`，Kotlin + 系统 WebView）：首页宫格、WebView 展示、遥控器按键映射、轮询 / 2×2 分区、摄像头画面墙、**素材展示页（MediaDisplay）**、受控通道。
- **电脑浏览器客户端**（`server/client/index.html`，构建产物）：同源单文件页，能力与电视端基本对齐，被控时不锁鼠标。
- **独立控制台**（`/console`）：平板书签直达的纯控制端，自身**不注册**为受控设备；也是素材上墙的上传/预览/下发入口。

当前版本基线：**Android 2.3 / versionCode 26**；服务端零第三方运行时依赖（`esbuild`、`playwright-core` 均为可选增强；素材上墙的 PDF/PPT 转换依赖可选系统工具 `poppler-utils` / `LibreOffice`）。

生产环境：systemd 单元 `tvshow.service`，工作目录 `server/`，默认 `18000` 端口。

---

## 2. 目录与职责

```
server/
├── server.js         # 装配与启动（端口 / 优雅退出 / 模块组装）
├── routes.js         # 路由：页面托管、/api/config 增量协议、/api/admin/*、入口校验
├── store.js          # config.json：种子 / 归一化 / 原子写盘 / 串行 mutate
├── http-util.js      # HttpError / sendJson / readBody / CORS
├── ctl.js            # 多设备互控：心跳、设备档案、指令、模式、场景
├── media.js          # 素材上墙：上传 / PDF·PPT 转图片（可选工具）/ 播放页 / Range 流式
├── page-watch.js     # 页面改版探测：ETag/Last-Modified 或正文指纹 → 心跳下发
├── proxy.js          # 反向代理：地址改写、自动登录注入、旧内核兼容转译
├── transpile.js      # esbuild 语法降级 + 运行时垫片 + 内容寻址缓存
├── shot.js           # 极速模式：无头 Chromium 截图 + 会话回收 + 页面改版重载
├── camera.js         # 摄像头 RTSP → MJPEG（按行 hstack）
├── client/index.html # 电脑端客户端（构建产物，勿手改）
├── admin/index.html  # 管理后台（构建产物，勿手改）
├── console.html      # 远程控制台（构建产物，勿手改）
├── data/             # 运行期数据（.gitignore；首次启动自动生成）
│   ├── media/        # 素材原文件与转换产物（0700/0600，不入库）
│   └── media.json    # 素材注册表（+ .bak，0600，不入库）
└── test-*.mjs        # 验证脚本；入口 test-run.mjs（隔离实例）

tools/                # 页面模板与构建脚本（admin / console / client / preview）
app/src/main/java/com/digitalcenter/tvshow/
├── config/           # AppConfig（模型/解析）、LocalSettings（本机设置）、CommandApplier（指令映射）
├── net/              # ConfigClient / ConfigStore / ConfigRepository / ControlChannel
├── ui/               # Main / WebDisplay / ZoneDisplay / CameraWall / MediaDisplay / Settings / TvDialogs / WebViewFactory
└── util/             # UiUtil、ViewportFit
docs/                 # 架构、API、部署运维、排障、发布说明、设计方案
dist/                 # 交付产物（preview.html 入库；*.apk 忽略）
```

---

## 3. 启动 / 构建 / 测试（高频命令）

```bash
# 服务端（零依赖，默认 18000）
node server/server.js
node server/server.js --port 9000 --host 127.0.0.1

# 全量检查：隔离实例回归 + Kotlin 单测 + Kotlin 编译（不打包 APK）
GRADLE_FLAGS=--offline ./scripts/check.sh

# 服务端隔离回归（自己起临时端口 + 临时数据目录，跑完即删）
node server/test-run.mjs

# 页面模板改动后必须重新构建（产物在 server/ 下，服务端每次请求读盘）
node tools/build-pages.mjs      # server/admin/index.html + server/console.html
node tools/build-client.mjs     # server/client/index.html
node tools/build-preview.mjs    # dist/preview.html

# Android（需要 JDK 17）
export JAVA_HOME=/opt/java/jdk-17.0.20.1+1    # 本机已有；其他环境按实际路径
./gradlew :app:testDebugUnitTest
./gradlew :app:compileDebugKotlin
./gradlew :app:lintDebug
./gradlew :app:assembleRelease
cp app/build/outputs/apk/release/app-release.apk dist/TvShowCenter-v2.3-release.apk
# 打包后核对版本与签名（麒麟机 build-tools 路径）
/opt/android-sdk/build-tools/35.0.0/aapt2 dump badging app/build/outputs/apk/release/app-release.apk | grep ^package
/opt/android-sdk/build-tools/35.0.0/apksigner verify --print-certs dist/TvShowCenter-v2.3-release.apk

# 素材上墙的系统依赖（麒麟 V10；装完必须重启服务刷新探测）
yum install -y poppler-utils                                            # PDF → 图片（pdftoppm/pdfinfo）
yum install -y libreoffice-impress libreoffice-writer libreoffice-filters # PPT/DOC → PDF
systemctl restart tvshow && curl -s localhost:18000/api/admin/health     # 看 media.tools 是否双 true
```

**生效规则**：

| 改动 | 如何生效 |
| --- | --- |
| `tools/*-template.html`、`tools/fragments/*` | 重新构建；服务端无需重启（页面每次读盘） |
| `server/*.js`（server.js、ctl.js、routes.js、media.js…） | **必须重启** `systemctl restart tvshow`（新增路由不重启会 404） |
| Android 代码 | 重新编译并安装 APK（versionCode 必须递增） |
| `server/data/config.json` 内容 | 管理后台保存后自动 bump version，客户端 ≤3 秒同步 |
| `server/data/media*` 素材 | 上传/转换即时生效；删除后正在展示的设备显示「素材不存在」 |
| 服务器装/卸 `poppler-utils`、LibreOffice | 重启服务刷新 `media.tools`；**已标记 unsupported 的素材需删除重传** |

---

## 4. 必须遵守的数据与安全约定

- `server/data/config.json`、`devices.json`、`media.json` 及其 `.bak`、`.baseline-backup`、`.tmp-*`，以及 `server/data/media/`（素材原文件 + 转换产物）是**现场运行期数据**，已加入 `.gitignore`，**不要提交**。首次启动由 `store.js` / `ctl.js` / `media.js` 种子自动生成。
- `dist/*.apk` 同样不入库（`.gitignore`），只保留在产物目录。
- 管理接口内网**免鉴权**，配置里含自动登录明文口令；唯一防线是用防火墙限制 `18000` 的访问范围。
- 日志：`server/server.log`，轮转配置 `deploy/tvshow.logrotate`。
- 环境变量：
  - `TVSHOW_DATA_DIR`：数据目录（测试隔离用）
  - `TVSHOW_CTL_OFFLINE_SEC`：设备离线阈值（默认 9 秒 = 3 次心跳）
  - `TVSHOW_PAGE_WATCH_SEC`：页面改版探测周期（默认 30，最小 5，`0` 关闭）
  - `TVSHOW_TRANSPILE_CACHE`：兼容转译缓存目录
  - `PORT` / `HOST` 或 `--port` / `--host`

---

## 5. 核心机制（改代码前必须知道）

### 5.1 配置同步与「运行期即时生效」

- `GET /api/config?since=<version>&epoch=<epoch>`：304 / 增量 delta / 全量 full；删除用 tombstone + `prunedBeforeRev`，顺序用独立 `orderRev`。
- 心跳 `/api/ctl/beat` 的 `content` 携带 `{version, epoch, pages}`；客户端发现落后立即强制同步。
- **电视端每 2 秒（仅前台）比对配置快照**：当前入口对象（地址/缩放/自动适配/兼容转译/极速参数/自动登录）变化 → 按新配置重载；只有其他页面变化 → 不重载。分区页逐格比较，只重建变化格。
- **页面改版探测**（`page-watch.js`）：每 30 秒取入口页 ETag/Last-Modified；无校验头时用正文前 64KB 哈希，且要求连续两轮一致才确认；正文持续变化（实时数据页）判定不可靠并停止探测。指纹经心跳 `content.pages` 下发，展示页/分区页发现当前页指纹变化即重载；极速模式的常驻截图页由服务端 `shot.reloadIfActive()` 重载。

### 5.2 多设备互控（`ctl.js` + `/console`）

- **设备身份只认客户端本地 `tvshow.deviceId`**（Web 端 `localStorage`，APK `SharedPreferences`）。
  **绝对不要按 IP / MAC 归并**：路由器 NAT 后整片设备共享同一来源地址；跨网段时服务端 ARP 只有网关 MAC，按 MAC 归并会把网关下所有设备并成一台；Android 10+ 还会随机化 MAC。曾实现过按 IP 归并，已按现场要求撤销。
- 心跳 3 秒；离线判定 9 秒（连续 3 次未收到）；离线设备不下发指令（控制台拦截并提示）。
- `managed` 是模式权威：展示类指令（`show/rotate/zone/home/media`）自动置 `true`；`release` / `switchTo:"local"` 置 `false` 并清空 `desired`。维护类指令（`refresh/sync/turbo`）不改变模式。
- `desired` 只保留最后一条（覆盖不排队）；维护类 ack 后清除，展示类保留（供开机恢复重发）。
- **回归即本地控制**：页面重开（`boot`）或离线超过阈值后回归，一律 `managed=false`、丢弃未确认指令，不会自动恢复旧画面。
- 受控设备本地操作偏离指令画面 → 自动 `switchTo:"local"` 交还；若有未确认展示指令在途则**指令优先**。
- 删除设备是**临时移除**（删档案，下次心跳自动重新注册），不是永久屏蔽。
- 控制台是纯控制端：**自身不注册为受控设备**，打开它的平板/电脑不会被自己下发锁住。
- 设备卡状态顺序固定：**在线/离线（绿/黄）→ 本地/远程控制（绿/蓝）→ 版本 → IP → 画面摘要（显示：xxx / 轮询中 / 素材：xxx，无上报不显示）**；不显示「暂无上报」。点击类型标签循环 `PC → PAD → TV`，手动类型优先于心跳上报。
- 控制台卡片是增量渲染：`deviceSignature` **必须包含所有可见字段**（含 `reported.turbo`）。曾漏掉 turbo，导致本机切换后卡片不重建、按钮永远显示旧值。
- 下发成功后控制台**立即本地重绘** `managed=true`（再靠 3 秒轮询对齐）；设备列表轮询在卡片下拉聚焦时只暂缓那一张卡，不能整体停更新。

### 5.3 旧内核兼容转译（电视白屏的头号原因）

- 现场小米电视 WebView 多为 **Chrome 66**；现代产物里的 `??`（Chrome 80）、类字段（72）是**硬语法错误**，解析即白屏，polyfill 救不了。
- 解决：管理后台给入口勾选 **「旧内核兼容转译」**（`compatTranspile: true`，可选 `compatTarget` 默认 `chrome66`）。电视端会改为经 `{server}/proxy/<id>/...` 加载，服务端用 esbuild 降级 + 注入运行时垫片。
- 依赖 `server/node_modules/esbuild`；缺失时自动退回原样透传，服务端仍可启动。
- 转译入口的 JS/HTML **不能走 304**（已强制回源 + `no-cache`），否则浏览器永远用旧产物。
- **白屏定位**：大屏页按【菜单】→ 信息浮层显示真实加载地址与「兼容代理/直连」；白屏面板会附最近一条脚本错误。注意：提示层底部 `菜单 刷新重试     返回 退出` 是**提示文案**，菜单里的实际选项叫 **「刷新页面」**；「页面加载失败」面板的按钮文案是「按【确定】重新加载」。
- 现场案例（2026-11-10）：`entry-697309`（物探中心网络监控系统）与 `security-cockpit` 已因现代构建开启该开关并验证。

### 5.4 极速模式（截图展示）

- 本机总开关（`LocalSettings.turbo`）+ 入口级 `turboEnabled/turboIntervalSec/turboQuality`（后台配置）。
- 服务端 `shot.js` 用无头 Chromium 按入口周期截图，客户端加载 `/shot/<id>/view` 包装页轮询帧；无人观看 30 秒后降频/暂停，30 分钟热保活期满关闭。
- 页面重新发布时 `pageWatch` 回调 `shot.reloadIfActive(id)` 重载采集页；无观看者时不做事。
- `playwright-core` + Chromium 缺失时自动降级，不阻塞服务端启动。

### 5.5 素材上墙（`media.js` + 互控 `media` 指令，2.2 新增 / 2.3 手动播放）

> 需求原话：「点击某个设备 → 素材上墙 → 从本地选择素材上传 → 立刻在大屏展示」；后续明确：**图片/PDF/PPT 统一转换成图片格式，转换期间给实时进度条，播放时允许手动和定时；视频不转图直接播放**。实现严格按此模型，改代码前先确认不要破坏它。

#### 5.5.1 统一模型（最重要，别改歪）

- **所有非视频素材最终都是「一页或多页 PNG」**：图片 = 本身就是 1 页（上传即 `ready`，不转换）；PDF/PPT/PPTX/DOC/DOCX = 服务端栅格化成 `page-N.png` 序列。播放端看到的永远是同一套分页播放器 + 同一套 URL，**不要为 PPT 单独做一套渲染/播放逻辑**。
- **视频不转换**：MP4/WebM 上传即 `ready`，播放页用 `<video autoplay muted loop>` 直接播；`/media/<id>/raw` 必须支持 Range（206/416），否则部分内核拒绝起播或无法拖动。
- **两端同一地址**：Web 与 TV 都只加载 `GET /media/<id>/view?interval=N`（**ES5，Chrome 66 底线**，与 `/shot/<id>/view`、`/cam/view` 同构）。任何新增播放能力都必须同时适用于两端，不要用 Web 专属 API。
- **不可上墙的类型**：XLS/XLSX（版式不可读，让源端导 PDF）、HLS/RTSP（用 `type=camera` 画面墙）、Office 在线嵌入/外部网页（用普通入口 + `show` 指令）。

#### 5.5.2 服务端结构（`media.js`）

- 路由：`/api/media`（列表）、`/api/media/upload?name=`（上传）、`DELETE /api/media/<id>`；`/media/<id>/{view,raw,preview,progress,page-N.png}`。
- 注册表 `server/data/media.json`（原子写 + `.bak`，0600）；素材文件 `server/data/media/<id>.orig`、`<id>.pdf`（PPT 中转产物）、`<id>.page-N.png`、`<id>.rawpage-*.png`（转换中，完成后改名）。目录 0700。字段：`id/name/kind/ext/size/pages/phase/total/status/reason/intervalSec/createdAt`。
- **上传是原始字节流**（请求体即文件，不做 multipart —— 零依赖），200MB 上限（先看 `Content-Length` 直接 413，落盘时逐块复核），扩展名白名单（`.jpg/.jpeg/.png/.gif/.webp/.bmp/.svg/.pdf/.ppt/.pptx/.doc/.docx/.mp4/.webm`），**流式直写磁盘**（`fs.createWriteStream` + `req.pipe`，RSS 不随文件大小线性增长；test-media 断言 80MB 上传 RSS 增长 <80MB）。文件名只取 `basename`、限 120 字符。
- **转换是异步且可选的**：`processing → ready | unsupported`，`unsupported` 必带人话 `reason`。工具缺失不能阻塞启动，也不能影响上传（文件照常入库）。
  - PDF：`pdfinfo` 取页数 → `pdftoppm -png -r 120` → 归一化成 `page-N.png`。
  - PPT/DOC：`soffice --headless --norestore --convert-to pdf --outdir <media>` → 走同一条 PDF 管线。转换串行（`processChain`），soffice 超时 180s、pdftoppm 120s。
  - 工具探测：`hasTool()` 带 60s 缓存，启动时即预热（health 的 `media.tools` 尽早是布尔值而不是 null）。
- **装配顺序有依赖**：`server.js` 里 `createMedia()` 必须在 `createCtl()` **之前**创建（ctl 需要 `getMedia: () => media.exists` 做下发校验），router 注入 `getMedia`；`routes.js` 在**尾斜杠归一化之前**把 `/api/media/*` 与 `/media/*` 交给 `media.handle`（与 proxy/shot/ctl 同一惯例，模块内部自己兜 HttpError）。
- **状态接口**：`GET /api/admin/health` 的 `media` 字段给出 `{count, processing, unsupported, storageMB, rssMB, tools:{pdftoppm,soffice}}`——现场排查 PPT 不可用先看这里。
- **清理**：删除素材要连带删原文件、中转 PDF、分页图与残留 `rawpage`；`DELETE` 后再次下发立即 400（下发时经 `getMedia().exists` 校验）。

#### 5.5.3 转换进度（2.3 新增，实时）

- `GET /media/<id>/progress`：`{status, phase, done, total, percent}`。
  - `phase='convert'`（soffice→PDF）：单步 opaque，`percent=0`，前端放**不定长流动动画**；
  - `phase='raster'`：`total` 来自 `pdfinfo`，`done` = 输出目录里已生成的 `rawpage` 文件数，`percent = done/total`（封顶 99）；
  - `phase='done'`：`percent=100, done=total=pages`；
  - 列表接口每条素材也带 `progress`（控制台列表 chip 显示「转换中 45%」）。
- **不要用 registry 里的 `pages` 当进度**：它只在转换完成后才写入，转换中恒为 0。
- 控制台弹层 600ms 轮询 progress 驱动进度条 + 文本：「正在转换为图片：已转换 x/N 页（p%）」/「正在转换 PPT 为 PDF（LibreOffice）…」。上传字节流进度（XHR `upload.onprogress`）与转换进度**接力显示**，不是同一根进度条语义。

#### 5.5.4 播放页（自动 + 手动，2.3）

- **CSS 兼容底线同样是 Chrome 66**：绝对定位必须写显式 `top/right/bottom/left:0`，**不能用 `inset`**（Chrome 87+ 才支持）——否则 `#stage` 会塌缩成 0×0，电视端整屏纯黑，而控制台预览（新浏览器）正常（2026-11-12 现场踩过，`test-media` 已加断言）。
- 分页播放器：双缓冲两张 `<img>`（换页时新图 `onload` 后才切 z-index，避免白闪）、预加载下一页、到末页环绕、左下角页码指示。
- **自动播放**：按 `interval`（3–3600s，默认 10，来自指令 `intervalSec` 或弹层「每页停留」）定时翻页。
- **手动播放**（2.3）：右下角控制条 `◀ 上一页 / 暂停-播放 / 下一页 ▶`；键盘 `←/→` 翻页、`空格` 暂停/继续；电视端遥控器由 `MediaDisplayActivity` 把 `←/→/确定` 转发进 `__tvMediaNav('prev'|'next'|'toggle')`。
  - 暂停后页码静止（页码指示显示「已暂停」）；**手动翻页保持暂停态**；恢复自动时以当前时刻重新计时（不会立刻跳页）。
  - 受控锁定优先：远程被控时手动翻页键照常被 `interceptKeyLocked` 拦下（属展示操作），**【返回】放行**。
- 调试/测试钩子（生产也保留，体积可忽略）：`window.__tvMediaState()` 返回闭包真值 `{page, auto, cur, PAGES}`；`window.__tvMediaLog` 记录每次 `go()`（`via: tick|btn|key|nav`）。
- 图片页：全屏 `<img>` + `object-fit:contain`（黑底不变形，GIF 动图原生播放），加载失败 3s 自动重试。视频页：`<video>` + 失败重试 + `play()` 兜底。不可用素材：直接显示 `reason` 文案（含装哪个工具）。

#### 5.5.5 互控集成

- `media` 是**展示类指令**（`ctl.js` 的 `DISPLAY_CMDS`）：自动置 `managed=true`、`desired` 覆盖不排队、回归即本地控制、可入场景（本地设备把 `reported.mode==='media'` 转 media step）。
- 参数：`{mediaId 必填, intervalSec? 3–3600}`；服务端下发时校验素材存在性（删除后 400）。
- **脱离语义依赖 `lastApplied`**：电脑端 `applyCommand` 与电视端 `ControlChannel.followsCommand` 的展示类判定**都必须含 media**——漏掉会导致「本地操作偏离素材画面」不自动交还（曾漏过，test-media-ui 已覆盖）。
- 状态上报 `mode:'media' + mediaId`：电视端 `ControlChannel.reportMedia()`；电脑端 `currentState()` 里 `state.entry.isMedia` 分支。控制台设备卡摘要显示「素材：xxx」（在固定四项 在线/模式/版本/IP 之后，无上报不显示）。
- 旧客户端（<2.2 APK / 旧网页）收到 `media` 会**如实上报「客户端不支持指令（版本过旧）」**（`CommandApplier` 的 unknown 分支 / Web 的 else 分支）——排查「下发没生效」先看设备卡摘要与版本 chip。
- 电脑端用**伪入口** `mediaEntryOf()` 复用展示屏内嵌壳：`isMedia:true`、`turboEnabled:false`（防被极速模式路由到 `/shot`）、`autoFit:true`、`mediaViewUrl=/media/<id>/view?interval=N`；`srcOf()` 里 media 分支必须排在 turbo 之前。

#### 5.5.6 控制台上传 / 预览

- 入口：设备卡右侧「素材上墙」（单台）与底部操作条「素材上墙」（勾选集）。
- 弹层：选择文件（隐藏 input + 自定义按钮）→ XHR 上传带字节进度 → **就绪后自动下发**（图片/视频立即；分页素材轮询 `ready` 后自动，无需再点）；列表每行：缩略图 + 素材名（页数/大小）+ 类型 chip + 转换状态（含百分比）+「预览」+「上墙」+「删除」；「每页停留」下拉（5/10/15/20/30/60，默认 10）。
- **列表有独立轮询**：`syncList()` 2.5s 刷新（弹层关闭自停）；上传成功后必须主动调用它，否则首传素材在列表里看不到、删除按钮无从点起（曾踩）。
- 预览：缩略图走 `/media/<id>/preview`（图片=原图；分页=第 1 页；视频无预览，`onerror` 隐藏）；「预览」按钮与上墙后设备卡「素材：xxx」摘要都打开**同一预览浮层**（自建遮罩 z-index 70，高于素材弹层；16:9 iframe 内嵌同一播放页）。**Esc 必须只关预览浮层**（捕获阶段监听 + `stopPropagation`，见 §8）。预览与设备端不是逐帧镜像：分页素材各自按间隔翻页。
- 素材弹层复用了控制台通用 `formModal`：`#modalBox`，footer 按钮用 `.modal footer .btn` 定位；确认弹层用 `.confirm-btn`。

#### 5.5.7 电视端（`MediaDisplayActivity`，2.2 起）

- 独立 Activity（`AppTheme.Fullscreen`、横屏、`FLAG_KEEP_SCREEN_ON`），URL = `{serverBaseUrl}/media/<id>/view?interval=N`，用 `WebViewFactory.create` 走统一 1920×1080 视口装配 + `applyInitialScale`。
- 键位：`←` 上一页、`→` 下一页、`确定` 暂停/继续（`evaluateJavascript("window.__tvMediaNav && …")`）、`菜单` 控制菜单（刷新页面/返回首页）、`返回` 退出。**受控锁定检查必须放在这些分支之前**。
- 上报：`onResume` → `ControlChannel.reportMedia(mediaId)`；实现 `CommandApplier.Reloadable`，`reloadCurrent()` = `webView.reload()`。
- 注册：`AndroidManifest.xml` 第 6 个 Activity（`exported=false`、`launchMode=standard`）。`CommandApplier.applyMedia()` 用 `CLEAR_TOP | NEW_TASK` 启动，`mediaId` 为空时报 `lastError` 不切页（避免错误锁定）。
- 新增 `CommandApplier` 指令时必须同步**五处**：`DISPLAY_CMDS`、`apply()` 的 when 分支、`followsCommand`（若属展示类）、控制台 `applySentLocally` 的 `isDisplay` 列表、电脑端 `applyCommand` 的 `lastApplied` 判定。缺一就会出现「状态不交还 / 按钮不回显」。

#### 5.5.8 部署 / 现场运维（务必记住）

- **改 `server/*.js` 必须 `systemctl restart tvshow`**：素材上墙是新增路由，只更新 `console.html`（页面读盘即生效）而没重启进程，上传会报 **`未找到接口 POST /api/media/upload`**（现场 2026-11-12 真实发生，见 §8 第 4 条）。
- 依赖：
  - PDF：`poppler-utils`（提供 `pdftoppm`、`pdfinfo`）。麒麟 V10：`yum install -y poppler-utils`。
  - PPT/DOC：LibreOffice。**麒麟 V10 源里没有 `libreoffice-headless` 这个包名**，实际装：`yum install -y libreoffice-impress libreoffice-writer libreoffice-filters`（core/data/draw/gtk3 等自动带入；2026-11-12 实测 6.3.6.2 可用）。
  - 中文字体：Noto CJK 已随系统（`fc-list :lang=zh`），转换出的页面中文正常。
  - 注意：该版本 soffice **不能导出 pptx**（`no export filter`），但 **pptx/docx → pdf 完全正常**——上墙只用后者，别被导出报错误导。
- 工具装好后：**重启服务**（刷新 `media.tools` 探测）→ 之前标记 `unsupported` 的素材**不会自动恢复**，需删除重传。
- 客户端：电视端要 ≥2.2（`MediaDisplayActivity` 在 2.2 引入）；已打开的电脑端标签**必须刷新一次**（F5）才会执行含 media 分支的新 JS。
- 运维自查：`GET /api/admin/health` → `media.tools` 双 true 才能上 PPT/PDF；`GET /api/media` 看素材与 `progress`。

#### 5.5.9 版本演进与本次交付记录（2026-11-11 ~ 12）

| 版本 | 内容 |
| --- | --- |
| 服务端（无版本号） | 新增 `media.js`、`/api/media/*`、`/media/*`、互控 `media` 指令、health.media、`test-media.mjs`/`test-media-ui.mjs` |
| **APK 2.2 / versionCode 25** | 新增 `MediaDisplayActivity` + `CommandApplier.applyMedia` + `ControlChannel.reportMedia` + Manifest 第 6 个 Activity；电脑端内嵌播放页 |
| **APK 2.3 / versionCode 26** | 播放页手动播放（控制条/键盘/遥控器转发）；服务端转换实时进度（`/progress`）；控制台预览（缩略图/预览浮层/可点摘要） |
| 现场运维 | 2026-11-12 装 poppler-utils + LibreOffice（impress/writer/filters）并重启；实测 PPTX→2 页 PNG 全链路通过 |

交付验证口径：服务端隔离回归 **396/396**、Kotlin 单测 19/19、lint、`assembleRelease`（v2.3，签名有效）；`test-media` 含性能基准（20MB/60MB 上传、RSS、24 路并发、首字节）。本机无 KVM，电视端真机交互按部署自检清单 36–41 条现场确认。

### 5.6 反向代理与自动登录

- 代理只允许 `/proxy/<已配置入口 id>/...`，目标由入口 `url` 推导，禁止 URL 参数指定目标（防 SSRF），并拒绝指向服务端自身。
- HTML 注入 shim：把上游绝对地址、根相对地址、fetch/XHR/WebSocket/EventSource 收敛到代理前缀；history 路由 SPA 用入口字段 `spaHistory: true` 剥离前缀。
- 自动登录脚本与电视端同一份（`app/src/main/assets/js/auto_login.js`），代理会注入到页面，标记 `__TV_AUTOLOGIN_SERVER__` 防重复。
- 摄像头画面墙 `type: camera`：RTSP 凭据只留在服务端 `config.json` 的 `cameras`，管理后台不暴露；按行 `hstack` 合成避免浏览器 6 连接上限；全局最多 14 个 ffmpeg 进程。

---

## 6. 电视端（Android）关键约定

- **Android 6.0 / minSdk 23 / targetSdk 34**，横屏全屏；不引入第三方库（HTTP 用 `HttpURLConnection`，JSON 用 `org.json`）。
- **缓存必须逐字段写全**：`ConfigStore.kt` 是手写字段清单，漏写任何「解析时会读」的字段，下次启动会回落默认值，而服务端版本没变时返回 304，该字段**再也补不回来**。新增入口字段时：
  1. `ConfigStore` 写入 + 读取；
  2. 必要时递增 `ConfigRepository.CACHE_SCHEMA` 作废旧缓存；
  3. 已装机现场可用 `POST /api/admin/epoch/bump` 抬 epoch 触发全量。
- **视口**：电视 WebView 需强制 CSS 视口 ≥1920×1080。`WebViewFactory` 统一做密度重写 + `setInitialScale`，`ViewportFit` 实测 `innerWidth` 反向校准；分区 4 格各自按 1920×1080 建立视口。
- **遥控器**：`WebDisplayActivity.dispatchKeyEvent` 处理返回/菜单；方向键与确定键透传 WebView，由 `tv_nav.js` 捕获阶段导航。任何按键到达时若 WebView 失焦会自动聚焦。
- **被控行为**：电脑/平板被控只切画面、不锁鼠标；电视端锁定方向/确定/菜单（Toast 提示），**【返回】放行**用于现场退出。
- **弹窗**：管理后台/控制台的弹窗**只能通过按钮或 Esc 关闭**，点击遮罩不关闭（平板软键盘弹出易误点）；安卓 `TvDialogs` 确认框 `setCancelable(false)` + `setCanceledOnTouchOutside(false)`。
- **APK 版本**：小米电视覆盖安装要求 `versionCode` **严格递增**，禁止回退；签名需 v1+v2+v3（`build.gradle.kts` 已配），否则内置安装器报「检测安装包异常」。发布证书 `keystore/tvshow-release.jks`，口令在 `gradle.properties`（示例值，正式外发前应替换）。
- **本地设置**：轮询（开关/间隔/序列/时钟起点）、分区四格、极速开关均在本机，各台电视互不影响；无服务端指令时行为与旧版本一致。
- **素材展示页（`MediaDisplayActivity`，2.2 起 / 2.3 加手动翻页）**：第 6 个 Activity（`AppTheme.Fullscreen`、横屏、`exported=false`、`standard`），加载服务端 `/media/<id>/view?interval=N`；用 `WebViewFactory` 统一视口装配。键位：`←/→` 手动翻页、`确定` 暂停/继续（`__tvMediaNav` 钩子）、`菜单` 控制菜单、`返回` 退出；**受控锁定检查在这些分支之前**（手动翻页属展示操作会被拦，【返回】放行）。`onResume` 里 `ControlChannel.reportMedia(mediaId)`，实现 `Reloadable` 供 `refresh` 指令刷新。新增指令时 `DISPLAY_CMDS`/`apply()`/`followsCommand`/控制台 `applySentLocally`/电脑端 `lastApplied` 五处必须同步（见 §5.5.7）。

---

## 7. 测试与验收

```bash
node server/test-run.mjs          # 396 项：API 44 + 管理 20 + 同步 13 + 代理 42
                                  # + 摄像头 17 + 极速 36 + 素材功能与性能 36 + 互控接口 84
                                  # + 互控 UI 66 + 素材端到端 27 + 页面改版探测 11
```

- **必须跑隔离实例**：`test-run.mjs` 会自起临时端口 + 临时数据目录；直接打生产 `18000` 会改写现场数据。
- UI 套件（`test-ctl-ui.mjs` / `test-media-ui.mjs`）依赖 `playwright-core` + Chromium；缺失时脚本打印 `SKIP` 并退出 0——**看到 SKIP 不等于通过**。
- Kotlin 单测 19 项（LocalSettings / ConfigJson 往返 / ConfigClient.merge / CommandApplier 决策，含 media 指令映射与未知指令上报），CI 另跑 `lintDebug`。
- **素材上墙两个套件**：
  - `test-media.mjs`（36 项，服务端+性能）：上传/白名单 400/空体 400/超大 Content-Length 413/列表脱敏/删除/预览/分页图/Range 206+末尾 Range/播放页 ES5 与控制条/`progress` 相位断言（convert|raster，done≤total，完成 percent=100）/media 指令校验与闭环/场景 step/落盘权限 0600+0700/**性能基准**（20MB、60MB 上传，RSS 增长 <80MB，24 路并发分页图 <3s，播放页首字节 <500ms）。
  - `test-media-ui.mjs`（27 项，双页面端到端）：控制台弹层上传 → **实时进度文本** → 就绪自动下发（含 intervalSec）→ 显示端内嵌播放页真实出图 → `reported.mode=media` → 卡片摘要「素材：xxx」→ 缩略图/预览浮层/Esc 分层关闭 → 本地操作自动交还 → 列表「上墙」→ 摘要点击预览 → 删除 → 分页首帧/自动翻页/暂停静止/手动翻页。
- **测试注意事项（都踩过）**：
  - 翻页断言用 `__tvMediaState()` 闭包真值，**不能只看 `ov` 文本**（`el.onload` 滞后一拍）；曾因测试里有**两次 `bNext` 点击**（2/3→3/3→环绕回 1/3）误判「手动翻页失效」，排查半天。加断言前先 `grep -c "bNext"`。
  - 播放页等待条件不要写成 `for (… && !ready)`：首拍拿到 `processing` 就退出会误判跳过。
  - `page.evaluate` 返回的是序列化对象，**不能对它 `.click()`**；点击用 Playwright 定位器。
  - 弹层内元素由 `syncList` 异步渲染，重开弹层后要等按钮出现再点（否则扑空 30s 超时）。
  - 失败用例的 `detail` 一定要带实时状态（`__tvMediaState`/`__tvMediaLog`/`ov`），否则只能盲猜。
- 改动涉及页面模板时，务必重新构建并确认产物与模板一致（`git status` 应只有预期的产物变化）。

---

## 8. 常见坑（按踩坑频率排序）

1. **旧内核白屏**：先看白屏面板的脚本错误；`Unexpected token ?` / 类字段 → 给入口开「旧内核兼容转译」。极速模式能显示、非极速白屏，几乎都是这个原因。
2. **新增配置字段没写进 Android 缓存** → 电视端永远拿不到（304 死循环）。见 §6。
3. **控制台卡片不更新**：检查 `deviceSignature` 是否包含该可见字段；检查是否因下拉聚焦导致整表停止重渲染（现已改为只暂缓当前卡）。
4. **改了 `server/*.js` 没重启** → 新接口 404 / 新逻辑不生效。典型现场（2026-11-12）：控制台已出现「素材上墙」按钮，但上传报 `未找到接口 POST /api/media/upload` —— 页面读盘即生效、路由要重启进程。`systemctl restart tvshow` 后 `curl /api/media` 应返回 200。
5. **改了模板没构建** → `/setting`、`/console`、`/` 还是旧页面。
6. **同一台电脑多浏览器各占一行**：这是预期（deviceId 独立）。想清掉：先关掉多余浏览器，再在控制台点「删除」；删除是临时移除。
7. **APK versionCode 不能回退**；覆盖安装必须递增，降级需卸载。
8. **代理转译入口的 JS 不要加缓存**（已处理），否则页面更新后仍加载旧脚本。
9. **摄像头并发**：不要给 3×3 每格单独一条 MJPEG 连接，会触发浏览器 6 连接上限；必须走按行合成。
10. **文档措辞**：提示层的「刷新重试」不是菜单项；菜单项是「刷新页面」。
11. **素材「不可用」四件事**：① 上传 PPT/PDF 报「不可用」先看 `health.media.tools`（是否 true）；② 工具装好后旧素材**不会自愈**，要删除重传；③ 已打开的电脑端标签必须 F5（旧 JS 不认 media 指令，只会静默不切画面）；④ 电视端要 ≥2.2 APK（`MediaDisplayActivity`），旧包只会静默上报「版本过旧」。
12. **控制台设备卡整卡消失 / 列表空白**：`buildDeviceCard` 里 `var r = d.reported` 是**后置声明**（var 提升值为 undefined），摘要块若用 `r` 会每卡抛错 → 整列表渲染中断。摘要块必须用 `d.reported`（曾踩，test-media-ui 已覆盖）。
13. **预览浮层 Esc 连带关掉素材弹层**：预览浮层必须自带遮罩并在**捕获阶段**监听 Esc + `stopPropagation`，否则会冒泡到控制台的通用 Esc 处理。
14. **转换进度看 `pages` 永远是 0**：转换中 `pages` 未写入，必须用 `/progress` 的 `done/total`；现场核对进度看 `GET /api/media` 里的 `progress`。
15. **素材上墙电视端纯黑、控制台预览正常**：播放页 CSS 用了 `inset:0`（Chrome 87+），Chrome 66 忽略后 `#stage` 塌缩成 0×0。必须写 `top:0;right:0;bottom:0;left:0`；`test-media` 已加断言防回归。

---

## 9. 文档地图

| 文档 | 用途 |
| --- | --- |
| `docs/素材上墙-分析与设计.md` | **素材上墙专项**：类型可行性矩阵（图片/PDF/PPT/DOC/视频与不可支持项）、依赖降级矩阵、总体架构、验证方案 |
| `docs/架构与实现.md` | 轮询/分区/同步协议/遥控器/自动登录/兼容转译/极速/素材上墙/互控/预览/代码结构 |
| `docs/API.md` | `/api/config`、管理接口、素材上墙接口（含 `/media/<id>/progress`）、入口字段 |
| `docs/部署与运维.md` | 交付物、安装、服务启动、安全、上线自检 |
| `docs/排障与验证.md` | 现场问题（白屏、缩放、视口）与历史验证记录 |
| `docs/发布说明-2.0.md` | 阶段 0–5 摘要、验收结果、上线/回滚清单、2026-11-10/11 现场修复 |

---

## 10. 当前已知限制 / 待办

- 真机 UI 与遥控器交互未在开发环境验证（无 KVM 硬件加速），改动 UI 后需现场确认。
- 发布证书与 `gradle.properties` 口令仍是交付示例值，正式外发前应替换；仓库历史中曾提交过含明文自动登录口令的配置文件，如需彻底清除需改写历史。
- 页面改版探测依赖 ETag/Last-Modified；两者都没有且正文持续变化的页面会被判定为「不可靠」并跳过（不会误重载，但也不会自动更新）。
- 同一台电脑的多个浏览器会各占一行设备卡（设计如此）。
- 极速模式依赖服务器安装 `playwright-core` + Chromium；兼容转译依赖 `esbuild`；摄像头依赖 `ffmpeg`；素材上墙的 PDF 转换依赖 `poppler-utils`（`pdftoppm`+`pdfinfo`）、PPT/DOC 依赖 `LibreOffice`（麒麟 V10：`libreoffice-impress libreoffice-writer libreoffice-filters`）。缺失时各自降级，不影响服务端启动。
- **素材上墙的画面是「静态页序列」，没有转场动画/动画效果**：PPT 里的动画、视频、切换特效**不会保留**（当前方案是版式保真的画面级展示，不是 PowerPoint 播放器）。若现场要求保留 PPT 动画/嵌入视频，需要另立方案（如转视频后用 `<video>`），不在本功能范围内。
- **XLS/XLSX 不支持上墙**：表格转图片版式不可读，需源端导出 PDF。
- **预览与设备端不是逐帧镜像**：分页素材各自按间隔独立翻页（观感确认用途）。
- 素材上墙的电视端真机交互（遥控器在素材播放页的锁定/返回/菜单、手动翻页键）未在开发环境验证（无 KVM），需现场按部署自检清单 36–41 条确认。
- 素材转换用的是服务器系统工具（pdftoppm/soffice），**峰值为单进程串行**（`processChain`）：一次只转一个文件，批量上传大 PPT 会排队；如需并发可改为限流池（当前规模不需要）。
- 上传上限 200MB、素材数量上限 200 个（`media.js` 常量）；超限分别 413 / 400。
