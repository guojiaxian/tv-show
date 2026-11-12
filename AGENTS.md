# AGENTS.md · 项目交接记忆

> 面向后续接手的 AI 编程助手 / 工程师。先读本文，再按需查阅 `docs/` 下的详细文档。
> 本文记录的是「代码里看不出来、但踩过坑」的约定与背景，改动前请先确认相关条目。

---

## 1. 项目是什么

**大屏聚合平台（TV Show Center）**：面向小米电视 / Android TV 的大屏展示应用。

- **服务端**（`server/`，Node.js）：页面列表与配置的唯一数据源、反向代理、兼容转译、极速截图、摄像头 MJPEG、多设备互控控制通道。
- **电视端 APK**（`app/`，Kotlin + 系统 WebView）：首页宫格、WebView 展示、遥控器按键映射、轮询 / 2×2 分区、摄像头画面墙、受控通道。
- **电脑浏览器客户端**（`server/client/index.html`，构建产物）：同源单文件页，能力与电视端基本对齐，被控时不锁鼠标。
- **独立控制台**（`/console`）：平板书签直达的纯控制端，自身**不注册**为受控设备。

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
```

**生效规则**：

| 改动 | 如何生效 |
| --- | --- |
| `tools/*-template.html`、`tools/fragments/*` | 重新构建；服务端无需重启（页面每次读盘） |
| `server/*.js`（server.js、ctl.js、routes.js…） | **必须重启** `systemctl restart tvshow` |
| Android 代码 | 重新编译并安装 APK |
| `server/data/config.json` 内容 | 管理后台保存后自动 bump version，客户端 ≤3 秒同步 |

---

## 4. 必须遵守的数据与安全约定

- `server/data/config.json`、`devices.json` 及其 `.bak`、`.baseline-backup`、`.tmp-*` 是**现场运行期数据**，已加入 `.gitignore`，**不要提交**。首次启动由 `store.js` / `ctl.js` 种子自动生成。
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

### 5.5 素材上墙（`media.js` + 互控 `media` 指令，2.2 新增）

- **两端同一地址**：显示端只加载 `GET /media/<id>/view?interval=N`（ES5，Chrome 66 可执行）；图片全屏、PDF/PPT/DOC 为服务端栅格化图片的分页播放（**自动翻页 + 手动播放**：页内控制条「◀ 上一页 / 暂停-播放 / 下一页 ▶」+ `__tvMediaNav` 钩子 + 方向键/空格，暂停后页码静止、手动翻页保持暂停态）、MP4 为 `<video>` 循环（`raw` 支持 Range，起播必需）。电视端遥控器由 `MediaDisplayActivity` 转发（←/→/确定，受控锁定优先）；Web/预览用页内按钮与方向键。
- **转换是异步且可选的**：图片/视频上传即 `ready`；PDF/PPT 走 `processing → ready|unsupported`（pdftoppm / soffice 缺失时 unsupported + 原因，控制台可见）。**不要把转换改成同步**——soffice 一次可能几十秒。
- **转换进度是实时的**：`GET /media/<id>/progress` 返回 `{status, phase, done, total, percent}`——raster 相位（PDF→图片）按「输出目录里已生成的 rawpage 文件数 / pdfinfo 总页数」算百分比，convert 相位（soffice→PDF）为不定长（percent=0，前端放流动动画）；列表接口每条素材也带 `progress`。控制台弹层 600ms 轮询它驱动进度条与「已转换 x/N 页」文本。**别用 registry 里的 pages 当进度**——pages 只在转换完成后写入。
- **上传是原始字节流**（`POST /api/media/upload?name=`，非 multipart、零依赖），200MB 上限、扩展名白名单、**流式直写**（RSS 有界，test-media 有断言）；存储在 `server/data/media/` + `media.json`（已 gitignore，0600/0700）。
- **`media` 是展示类指令**（ctl.js `DISPLAY_CMDS`）：自动接管、desired 覆盖、回归即本地控制、可入场景；下发时经 `getMedia` 校验素材存在性，删除后立即 400。
- **脱离语义依赖 `lastApplied`**：电脑端 `applyCommand` 与电视端 `ControlChannel` 的展示类判定**都必须含 media**——漏掉会导致「本地操作偏离素材画面」不自动交还（曾漏过，test-media-ui 已覆盖）。
- **控制台弹层的素材列表有自己的轮询**（`syncList`，2.5s，弹层关闭自停）；上传后必须主动刷新它，否则首传素材在列表里看不到、删除按钮无从点起。
- **控制台可预览素材**：弹层每行有缩略图（`/media/<id>/preview`）+「预览」按钮，设备卡「素材：xxx」摘要在上墙后变为可点击——都打开同一预览浮层（独立遮罩 z-index 70，内嵌与设备端同一播放页）。**Esc 必须只关预览浮层**（捕获阶段监听 + stopPropagation），否则会连带关掉下层素材弹层。预览与设备端不是逐帧镜像：分页素材各自按间隔翻页。
- 旧客户端（<2.2 APK / 旧网页）收到 `media` 指令会上报「客户端不支持指令（版本过旧）」，控制台可见——排查「下发没生效」先看设备卡摘要与版本 chip。

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

---

## 7. 测试与验收

```bash
node server/test-run.mjs          # 396 项：API 44 + 管理 20 + 同步 13 + 代理 42
                                  # + 摄像头 17 + 极速 36 + 素材功能与性能 36 + 互控接口 84
                                  # + 互控 UI 66 + 素材端到端 27 + 页面改版探测 11
```

- **必须跑隔离实例**：`test-run.mjs` 会自起临时端口 + 临时数据目录；直接打生产 `18000` 会改写现场数据。
- UI 套件（`test-ctl-ui.mjs`）依赖 `playwright-core` + Chromium；缺失时脚本打印 `SKIP` 并退出 0——**看到 SKIP 不等于通过**。
- Kotlin 单测 19 项（LocalSettings / ConfigJson 往返 / ConfigClient.merge / CommandApplier 决策，含 media 指令映射与未知指令上报），CI 另跑 `lintDebug`。
- **测试 media 播放页的翻页断言必须用状态钩子**（`__tvMediaState` 闭包真值），不能只看 `ov` 文本——ov 由 `el.onload` 滞后一拍更新，页码变但文本未变会造成假失败（曾因此误判手动翻页失效，排查半天发现是测试点了两次按钮）。
- 改动涉及页面模板时，务必重新构建并确认产物与模板一致（`git status` 应只有预期的产物变化）。

---

## 8. 常见坑（按踩坑频率排序）

1. **旧内核白屏**：先看白屏面板的脚本错误；`Unexpected token ?` / 类字段 → 给入口开「旧内核兼容转译」。极速模式能显示、非极速白屏，几乎都是这个原因。
2. **新增配置字段没写进 Android 缓存** → 电视端永远拿不到（304 死循环）。见 §6。
3. **控制台卡片不更新**：检查 `deviceSignature` 是否包含该可见字段；检查是否因下拉聚焦导致整表停止重渲染（现已改为只暂缓当前卡）。
4. **改了 `server/*.js` 没重启** → 新接口 404 / 新逻辑不生效。
5. **改了模板没构建** → `/setting`、`/console`、`/` 还是旧页面。
6. **同一台电脑多浏览器各占一行**：这是预期（deviceId 独立）。想清掉：先关掉多余浏览器，再在控制台点「删除」；删除是临时移除。
7. **APK versionCode 不能回退**；覆盖安装必须递增，降级需卸载。
8. **代理转译入口的 JS 不要加缓存**（已处理），否则页面更新后仍加载旧脚本。
9. **摄像头并发**：不要给 3×3 每格单独一条 MJPEG 连接，会触发浏览器 6 连接上限；必须走按行合成。
10. **文档措辞**：提示层的「刷新重试」不是菜单项；菜单项是「刷新页面」。

---

## 9. 文档地图

| 文档 | 用途 |
| --- | --- |
| `docs/架构与实现.md` | 轮询/分区/同步协议/遥控器/自动登录/兼容转译/极速/素材上墙/互控/预览/代码结构 |
| `docs/API.md` | `/api/config`、管理接口、素材上墙接口、入口字段 |
| `docs/部署与运维.md` | 交付物、安装、服务启动、安全、上线自检 |
| `docs/排障与验证.md` | 现场问题（白屏、缩放、视口）与历史验证记录 |
| `docs/发布说明-2.0.md` | 阶段 0–5 摘要、验收结果、上线/回滚清单、2026-11-10/11 现场修复 |

---

## 10. 当前已知限制 / 待办

- 真机 UI 与遥控器交互未在开发环境验证（无 KVM 硬件加速），改动 UI 后需现场确认。
- 发布证书与 `gradle.properties` 口令仍是交付示例值，正式外发前应替换；仓库历史中曾提交过含明文自动登录口令的配置文件，如需彻底清除需改写历史。
- 页面改版探测依赖 ETag/Last-Modified；两者都没有且正文持续变化的页面会被判定为「不可靠」并跳过（不会误重载，但也不会自动更新）。
- 同一台电脑的多个浏览器会各占一行设备卡（设计如此）。
- 极速模式依赖服务器安装 `playwright-core` + Chromium；兼容转译依赖 `esbuild`；摄像头依赖 `ffmpeg`；素材上墙的 PDF 转换依赖 `poppler-utils`、PPT/DOC 依赖 `LibreOffice`（图片/视频无额外依赖）。缺失时各自降级，不影响服务端启动。
- 素材上墙的电视端真机交互（遥控器在素材播放页的锁定/返回/菜单）未在开发环境验证（无 KVM），需现场按部署自检清单 36–41 条确认。
