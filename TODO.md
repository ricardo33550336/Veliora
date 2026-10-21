# TODO / 待办

按优先级排列。已完成项见 git 记录；文末「已完成 / 已知限制」只记录现状，不是待办。

## P0 统一 Serverless 代理（与 server.mjs 对齐）— 已实现，待部署验证

**原问题**：仓库里有 4 套服务端代理 + 1 套 Android 原生代理，只有 `server.mjs` 和
`ProxyHandler.kt` 有重试/总预算/熔断/并发控制。另外三套 Serverless 版用 `response.text()`
读上游，会破坏海报二进制；没有豆瓣 Referer；还会把多码率 master 改成单码率。

**已做**：

- 新增 `lib/proxy-core.mjs`：Web 标准 API（fetch / AbortController / crypto.subtle），
  Node 18+ 与 Cloudflare Workers 共用。
- 行为对齐 `server.mjs`：UA 伪装、豆瓣图床 Referer、单次超时 + 总预算、只重试瞬时错误、
  host 熔断（含半开）、上游并发上限、敏感头过滤、二进制原样透传、m3u8 不改写。
- `api/proxy/[...path].mjs`（Vercel）、`netlify/functions/proxy.mjs`、
  `functions/proxy/[[path]].js`（Cloudflare）改为薄适配层，只负责解析路径/鉴权参数、
  把 `Uint8Array` 转成各平台响应。
- 本地测试已固化：`npm test`（`test/proxy-core.test.mjs` / `test/proxy-adapters.test.mjs`），
  覆盖二进制字节一致、JSON 透传、401、503 重试、403 熔断、读体超时、豆瓣 Referer、
  SSRF 拦截、三套适配器 + OPTIONS。
- `package.json` 移除已不再使用的 `node-fetch`，声明 `engines.node >= 18`。

**剩余**：

- [ ] 在 Vercel / Netlify / Cloudflare 各实际部署一次，验证豆瓣海报、JSON、m3u8 字节一致。
- [ ] 观察 Serverless 冷启动 + 平台 10s 上限下，`REQUEST_TOTAL_TIMEOUT=10000` 是否够用。
- [ ] 已知差异：Serverless 的 host 熔断/并发上限是**实例级**（冷启动重置），与 `server.mjs`
  的进程级不完全等价；要跨实例共享需接 KV/Redis。

## P1 详情页源标签增量更新（修焦点丢失）— 已修复

**原现象**：详情页各源并行返回，每返回一个就 `addDetailResults → renderSourceTabs`
（`js/tv-remote.js:1639`、`:1668`），而 `renderSourceTabs` 每次 `tabs.innerHTML = ''`
全量重建（`:1682`）。用户此时若停在某个源标签上，焦点节点被删除，下一次按键会
重新落到页面首个可聚焦元素。

**已做**：重建前记录焦点 tab 的 `data-source-code` 与原序号，重建后按 source_code 恢复
`setFocus`；找不到时按原序号回退。焦点在剧集网格时不干预。

**验收**：连续返回多个源时，焦点停在原 tab 上不跳；按 OK 仍直接切源/开播。

> 方案 B（清晰度探测）依赖此项，现在可以上了。

## P1 APK 构建验证与版本对齐

`ProxyHandler.kt` 已按 `server.mjs` 策略移植：总预算 10s、连接 5s / 读 8s、
只重试瞬时且秒失败的错误、host 熔断（含半开）、客户端断开即 cancel 上游、
连接池复用、上游并发上限、错误体与前端 `isHardSourceFailure` 对齐。

**但尚未验证编译**（本机无 JDK / Android SDK）。CI 的 `.github/workflows/build-apk.yml`
目前只有 `workflow_dispatch`，不会自动跑。

- [ ] 手动触发一次 `Build Veliora APK`，确认能出包。
- [ ] 装到电视上冒烟：搜索、详情、切源、原生播放、网页播放器兜底、代理重试/熔断。
- [x] `versionCode` 5 → 6（只增不减，避免无法覆盖安装）。
- [x] `versionName` 与 `package.json` 对齐（1.1.0）。

## P2 清晰度探测（方案 B）— 详情页已实现

**现状**：`loadEpisodes()` 拿到 `data.episodes` 后，仅当 `episodes[0]` 是 http(s) 的 m3u8
时才异步探测；只探当前选中的 1 个源。

**已做**：

- 通过 `/proxy/` 拉 master playlist（带鉴权参数），解析 `#EXT-X-STREAM-INF` 的
  `RESOLUTION=WxH`：多档显示 `1080P / 720P / 480P（3 档）`，单档显示 `1080P`，
  只有 `#EXTINF` 的媒体列表返回空、回退到方案 A（`vod_remarks` 猜测）。
- 4s 超时；`AbortController` 在切源/离开详情时取消；`detailToken` 防串台。
- 按 m3u8 URL 缓存 10 分钟（上限 100 条），失败静默、不记源健康失败。
- 结果只改选中 tab 的 `innerHTML`，不整排重绘，焦点不丢。
- 探测结果优先于 `vod_remarks` 猜测。

**剩余**：

- [ ] 实机验证若干真实源，观察单码率占比与徽章长度是否影响 tab 布局。
- [ ] 网页兜底播放器（`js/player.js` + hls.js）监听 `LEVEL_SWITCHED` 叠当前分辨率
  （方案 D；原生播放器 `PlayerActivity.kt:658-668` 已显示，优先级低）。

## P3 首屏后懒加载第 2 页

`API_CONFIG.search.maxPages` 目前为 `1`（为了把每源请求数从 5 降到 1）。
若确认结果覆盖不足，可在首屏渲染完成后再按源补拉第 2 页（`js/search.js`）。

**当前代码不支持直接加**：

- `searchByAPIAndKeyWord` 没有 page 参数，缓存 key 是 `apiId + '|' + query`
  （`js/search.js:154`），**不含页码**。直接请求第 2 页会命中第 1 页缓存或污染缓存。
- 第 2 页失败不能调 `recordSourceOutcome(false)`，否则不支持分页的健康源会被误判进冷却。

**建议**：

- 加 `page` 参数，缓存 key 带页码；第 2 页空结果用更短 TTL 或只做内存缓存。
- 触发条件收紧：**该源第 1 页返回满页 + `pagecount > 1` + 当前没有精确同名结果**。
- 每源独立后台请求，用独立 `AbortController`，随新搜索/离开页面取消。
- 结果合并进现有 `acc`，不要覆盖第 1 页缓存；UI 不因补拉而抢焦点/重排。
- 先加埋点统计「无精确匹配」比例，收益不足就不做。

## P4 服务端 API 响应缓存（谨慎，可暂缓）

仅对 `ac=videolist` / `ac=detail` 的 JSON 做带大小上限（如 512KB）的 TTL 缓存 +
同 URL 请求合并。

**先想清楚收益**：

- 客户端已有 5 分钟 `searchCache`（`js/search.js:75`），APK 主路径又是原生 `ProxyHandler`。
- 只给 `server.mjs` 加缓存，对主要用户基本无收益；要做就得同时考虑原生代理。

**若要做，硬性要求**：

- 只缓存有效 2xx JSON；TTL 短（30–120s），不要用静态资源的 `CACHE_MAX_AGE=1d`。
- LRU + 总字节上限，避免多用户/多源把内存打满。
- 不缓存错误体、空结果、m3u8、图片。
- 缓冲后必须重设 `content-length`，移除 `content-encoding`。
- 注意代理目前是 `responseType: 'stream'` 直接管道，做缓存必须整体缓冲响应体。

## 工程卫生 — 本轮已处理

- [x] 版本号对齐：Android `versionCode=6` / `versionName=1.1.0`，
  `js/config.js` 的 `SITE_CONFIG.version` 同步为 1.1.0。
- [x] `.codegraph/` 加入 `.gitignore`。
- [x] `scripts/start.sh` 可执行位已生效（待提交）。
- [x] `Dockerfile` 的 `REQUEST_TIMEOUT` 改回 8000，并补齐
  `REQUEST_TOTAL_TIMEOUT` / `MAX_UPSTREAM_CONCURRENCY` / `BREAKER_*`。

**仍可做**：把版本号收敛为单一来源（构建时从 `package.json` 注入 `versionName`），
`SITE_CONFIG.version` 目前仍未在 UI 中使用，可删或接入。

## 已完成 / 已知限制

### 已完成

- **清晰度徽章方案 A**：从 `vod_remarks` 正则猜清晰度，搜索卡片与详情页源标签显示。
- **搜索提速与稳定性**：单源单页抓取、只重试瞬时错误、断开即中止上游、源级熔断、
  结果流式渲染。
- **Android 代理同步 `server.mjs` 策略**：重试分类 / 总预算 / host 熔断 / 断开即取消 /
  连接池 / 上游并发上限，`versionCode` → 6。待按 P1 验证构建。
- **TVBOX 订阅**：`type=1` 自动转 CMS 源、缓存优先、启动自动刷新；修掉大写密码登不上。
- **原生播放器清晰度显示**：`showOverlayHint()` 已显示当前实际分辨率与手动锁定档位。

### 已知限制

- WebView 的 `shouldInterceptRequest` 是阻塞式，请求**等待响应头**阶段无法被 JS 侧 abort
  取消（只能靠 `callTimeout` 兜底）；只有**传输响应体**阶段能靠
  `CancelOnCloseInputStream` 关闭流时 `call.cancel()`。彻底可取消需要改成真正的本地
  HTTP 服务（类似 `server.mjs` 的 socket 级取消），属于更大改动。
