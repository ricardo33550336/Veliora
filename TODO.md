# TODO / 待办

按优先级排列。已完成项见 git 记录。

## 1. 清晰度探测（方案 B）— 待做

**现状（方案 A，已实现）**：从采集源返回的 `vod_remarks` 自由文本里用正则猜清晰度，
命中才在搜索卡片和详情页源标签上显示徽章（`js/tv-remote.js` 的 `extractQuality` / `bestQualityOf`）。
不可靠：很多源的备注只有「更新至12集」，猜不出清晰度。

**方案 B：探测 m3u8 主播放列表**（可靠）

- 位置：详情页「当前选中源」的源标签旁（`renderSourceTabs` / `loadEpisodes`）。
- 做法：取该源第一集的 m3u8 URL，经 `/proxy/`（必须带鉴权参数，直连会被 CORS 挡）拉取，
  解析 `#EXT-X-STREAM-INF` 的 `RESOLUTION=WxH` 与 `BANDWIDTH`：
  - 多档 → 显示如 `1080P / 720P / 480P（3 档）`
  - 单档带 RESOLUTION → 显示 `1080P`
  - 只有 `#EXTINF` 的媒体列表（单码率）→ 无法得知，显示 `—`
- 只探 1 个源、异步、失败静默；按 URL 缓存 ~10 分钟，超时 ~5s，不阻塞搜索与首屏。
- 注意：聚合源里单码率占多数，多数情况下可能仍是 `—`。

**方案 D（顺带）**：播放页叠加显示当前实际分辨率（`hls.level.height`，监听 `Hls.Events.LEVEL_SWITCHED`）。

## 2. 首屏后懒加载第 2 页 — 待做

`API_CONFIG.search.maxPages` 目前为 `1`（为了把每源请求数从 5 降到 1）。
若发现结果覆盖不足，可在首屏渲染完成、结果数 < 阈值时再补拉第 2 页（`js/search.js`）。

## 3. 服务端 API 响应缓存 — 待做（谨慎）

仅对 `ac=videolist` / `ac=detail` 的 JSON 做带大小上限（如 512KB）的 TTL 缓存 + 同 URL 请求合并。
注意：代理目前是 `responseType: 'stream'` 直接管道，做缓存必须整体缓冲响应体，
**绝不能缓存图片 / m3u8**（体积大、易 OOM）。

## 4. Android 端代理同步 — 已完成

`ProxyHandler.kt` 已移植 `server.mjs` 的策略：总预算 10s、连接 5s / 读 8s、
只重试瞬时且秒失败的错误、host 熔断（含半开）、客户端断开即 cancel 上游、连接池复用、
上游并发上限、错误体与前端 `isHardSourceFailure` 对齐。尚未在本机编译，需由 CI 或本地构建验证。

**遗留限制**：WebView 的 `shouldInterceptRequest` 是阻塞式，请求**等待响应头**阶段无法被
JS 侧 abort 取消（只能靠 `callTimeout` 兜底）；只有**传输响应体**阶段能靠
`CancelOnCloseInputStream` 关闭流时 `call.cancel()`。若要彻底可取消，需要改成真正的本地
HTTP 服务（类似 server.mjs 的 socket 级取消），属于更大改动。
