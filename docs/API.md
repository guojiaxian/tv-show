# API 接口与页面字段

> 客户端拉取接口、管理接口与入口字段说明。
> 文档索引：[README](../README.md)

## API 接口

管理接口（供后台页面调用，内网免鉴权）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/config` | 完整配置（含 version/epoch/rev） |
| PUT | `/api/admin/meta` | 修改系统标题等 |
| POST | `/api/admin/entries` | 新增页面 |
| PUT | `/api/admin/entries/:id` | 更新页面 |
| DELETE | `/api/admin/entries/:id` | 删除页面 |
| POST | `/api/admin/entries/reorder` | 按 `ids` 重排 |
| POST | `/api/admin/epoch/bump` | 强制客户端下次重拉全量 |
| GET | `/api/admin/health` | 健康检查 |

客户端接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config?since=<version>&epoch=<epoch>` | 增量拉取：无变更为 `304`，否则返回全量或增量 |
| GET | `/api/config?full=1` | 强制全量 |
| GET | `/api/cameras` | 摄像头列表（编号、标题、在线状态），只下发展示参数，**不含 RTSP 地址与凭据** |
| GET | `/cam/<编号>.mjpg?q=high` | 摄像头实时画面（MJPEG 流）：`q=high` 主码流，缺省子码流 |
| GET | `/cam/wall.mjpg?row=<1..3>` | 画面墙**一整行**的合成画面（3 路 `hstack` 成 1920×360），行号越界返回 `400` |
| GET | `/cam/logo.png` | 画面墙品牌格图片（客户端叠在黑底上显示），未配置时返回 `404` |
| GET | `/api/version` | 极轻量的版本探测 |

多设备互控 · 控制通道接口（`/api/ctl/*`，内网免鉴权，与 `/api/admin/*` 同一信任模型）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ctl/beat` | 设备心跳（3s 一拍）：注册 / 上报状态 / 领指令；`switchTo` 字段保留协议兼容（当前客户端不发送） |
| POST | `/api/ctl/send` | 下发指令 `{targets, cmd, args}`；展示类（show/rotate/zone/home/**media**）自动接管，维护类（refresh/sync/turbo）不改模式；`targets:["*"]` = 全部设备 |
| POST | `/api/ctl/release` | 「取消控制」：目标设备 `managed=false` 并清空 desired；传 `home:true` 为「退出上墙」：先下发 `home`，设备 ack 后自动交还本地 |
| GET | `/api/ctl/devices` | 设备列表（模式 / 在线判定 / reported 状态 / 待送达标记）+ 场景列表 |
| PUT / DELETE | `/api/ctl/device/:id` | 设备改名 / 从档案移除 |
| POST | `/api/ctl/scenes` | 保存场景：直接传 `steps`，或快照当前现场（受控设备取 desired，本地设备把上报状态转为等价指令） |
| POST | `/api/ctl/scenes/:id/apply` | 应用场景（逐台下发，seq 逐台自增；离线设备存储转发补投递） |
| PUT / DELETE | `/api/ctl/scenes/:id` | 场景重命名 / 删除 |

素材上墙接口（`/api/media/*` 与 `/media/*`，内网免鉴权；类型分析见[素材上墙-分析与设计](素材上墙-分析与设计.md)）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/media/upload?name=<文件名>` | 上传素材，请求体为**原始文件字节**（非 multipart）。支持：图片 jpg/jpeg/png/gif/webp/bmp/svg、PDF、PPT/PPTX、DOC/DOCX、MP4/WebM；上限 200MB（超限 413）。图片/视频即时 `ready`，PDF/PPT 异步转换（`processing → ready/unsupported`） |
| GET | `/api/media` | 素材列表（仅元数据：id/name/kind/label/size/pages/status/reason/createdAt） |
| DELETE | `/api/media/:id` | 删除素材（含转换产物）；正在展示它的设备会看到「素材不存在」提示 |
| GET | `/media/:id/view?interval=10&auto=0&loop=1` | **播放页**（ES5，Web 与 TV 两端共用）：图片全屏 / 分页**默认手动翻页**（`auto=0`）；`auto=1` 时按 `interval`（3–3600s，默认 10）自动翻页，`loop=0` 到末页停止 / `loop=1` 循环 / 视频循环播放。未显式带 auto/loop 时沿用该素材最近一次上墙方式（兼容旧客户端） |
| GET | `/media/:id/progress` | 转换进度（实时）：`{status, phase: convert\|raster\|done, done, total, percent}`；raster 按「已生成页数/总页数」报确定百分比，convert（soffice）为不定长（percent=0）；列表接口每条素材同样携带 `progress` |
| GET | `/media/:id/raw` | 原始文件（图片/视频）；支持 Range 请求（视频起播/拖动必需） |
| GET | `/media/:id/page-N.png` | 分页图片（PDF/PPT/DOC 的转换产物，1 起） |
| GET | `/media/:id/preview` | 预览图（图片→原图；分页→第 1 页；视频无预览 404） |

互控 `media` 指令（展示类，自动接管）：`args = { mediaId 必填, intervalSec? 3–3600, auto? 默认 false（手动翻页）, loop? 默认 true }`；下发时校验素材存在性；可入场景。控制台「上墙」下发 `auto:false`，「自动翻页」弹框下发 `auto:true + intervalSec + loop`。

> 服务端接口只围绕**内容**（元信息 + 页面列表）。轮询与分区是客户端本机设置，服务端不提供对应接口。

## 页面字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 否 | 唯一标识，留空自动生成；创建后不建议修改（客户端按 ID 识别页面） |
| `title` | **是** | 卡片标题（电视端建议 ≤20 字） |
| `type` | 否 | `url`（默认，普通网页）或 `camera`（**内置摄像头画面墙**，客户端直接播放实时画面，无需填 `url`） |
| `subtitle` | 否 | 卡片描述 |
| `url` | **是** | 大屏地址，必须以 `http://` 或 `https://` 开头；`type=camera` 时忽略 |
| `accent` | 否 | 主题色 `#RRGGBB` |
| `icon` | 否 | `storage` / `env` / `security` / `default` |
| `scale` | 否 | 缩放：`0` 自动适配，或 `50`–`200` |
| `autoFit` | 否 | 内容超宽时自动缩小铺满，默认 `true` |
| `allowInsecureSsl` | 否 | 忽略自签名证书错误，默认 `false` |
| `openOriginal` | 否 | **强制原址打开**：点击卡片时在新标签页直接访问原地址（配了自动登录则走代理地址，由服务端注入自动登录脚本），不进内嵌壳；轮询展示自动跳过。默认 `false` |
| `spaHistory` | 否 | **history 路由 SPA**：代理打开报 SPA 自身 404（如 Uptime Kuma 的「未找到该页面」）时勾选，代理会在页面启动时剥离代理前缀，让 SPA 路由正确匹配。传统多页站点勿开。默认 `false` |
| `autoLogin` | 否 | 自动登录：`enabled` / `username` / `password` / 4 个可选选择器 |

---

