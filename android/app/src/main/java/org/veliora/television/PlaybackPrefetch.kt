package org.veliora.television

import android.net.Uri
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * 起播预热：在 ExoPlayer 真正打开播放列表之前，先把 m3u8 拉进进程内存。
 *
 * 起播要等的网络往返有两段：master playlist + 第一路子 playlist（多码率源）。详情页
 * 渲染剧集到用户按下 OK 通常有几百毫秒到几秒，足够拉完；点 OK 的那一下还会再补一次
 * （覆盖「进详情页停很久」和从历史直接开播的情况）。ExoPlayer 打开同一个 URL 时由
 * [PrefetchDataSource] 直接命中内存 —— 播放列表请求数为 0，只剩分片下载。
 *
 * 两个实现细节：
 * - 刻意用 HttpURLConnection：与 ExoPlayer 的 DefaultHttpDataSource 是同一套连接栈，
 *   读完没 disconnect 的 socket 会进进程级 keep-alive 池，紧跟着的分片请求能复用，
 *   省掉 DNS + TCP + TLS 握手（电视盒子上这三步常是 200~600ms）。
 * - 缓存的是「未经广告过滤的原始播放列表」，广告过滤仍由 M3u8AdFilterDataSource 现场做，
 *   所以预热不会影响过滤结果。
 *
 * 命中不了也没关系：PrefetchDataSource 会退回正常网络请求，最坏结果只是白下几 KB。
 */
object PlaybackPrefetch {

    private const val TAG = "VelioraPrefetch"

    // 播放列表只有 KB 级；上限给足异常情况，同时避免把内存打满
    private const val MAX_PLAYLIST_BYTES = 1 shl 20      // 1MB
    private const val MAX_ENTRIES = 8
    // 详情页选剧集的时间 + 播放页启动 + Activity 切换，正常都在这个窗口内。
    // 过期就重新拉：采集源的播放列表偶有带时效 token 的。
    private const val TTL_MS = 45_000L
    private const val CONNECT_TIMEOUT_MS = 4_000
    private const val READ_TIMEOUT_MS = 5_000
    private const val MAX_REDIRECTS = 3

    /** 预热到的一份播放列表：[baseUrl] 是跟随重定向后的最终地址，ExoPlayer 用它解析相对分片路径 */
    data class Playlist(val bytes: ByteArray, val baseUrl: String, val at: Long)

    // accessOrder = true：命中最少的（最久没用过的）先淘汰
    private val cache = object : LinkedHashMap<String, Playlist>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Playlist>?): Boolean =
            size > MAX_ENTRIES
    }
    private val inFlight: MutableSet<String> = Collections.newSetFromMap(
        ConcurrentHashMap<String, Boolean>()
    )
    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "veliora-prefetch").apply { isDaemon = true }
    }

    /** 预热一个播放地址；非 m3u8 / 已经在路上 / 缓存还新鲜时直接返回，不阻塞调用方 */
    fun warm(url: String?) {
        val target = keyOf(url?.trim().orEmpty())
        if (!isPlaylistUrl(target)) return
        if (isFresh(target)) return
        if (!inFlight.add(target)) return
        executor.execute {
            try {
                val started = android.os.SystemClock.elapsedRealtime()
                if (fetch(target, 0)) {
                    Log.d(TAG, "预热完成 ${android.os.SystemClock.elapsedRealtime() - started}ms $target")
                }
            } catch (t: Throwable) {
                // 预热失败不影响播放：播放器照常自己发请求
                Log.d(TAG, "预热失败 $target: ${t.message}")
            } finally {
                inFlight.remove(target)
            }
        }
    }

    /**
     * 取一份还新鲜的播放列表，取出即消费：同一个 URL 第二次请求走真实网络。
     * 这样即使源站的播放列表是一次性 token / 正在滚动更新，也不会反复喂旧内容。
     */
    fun take(url: String): Playlist? = synchronized(cache) {
        val key = keyOf(url)
        val entry = cache.remove(key) ?: return null
        if (System.currentTimeMillis() - entry.at > TTL_MS) return null
        entry
    }

    /** 播放失败时清空：避免用一份可能已经失效的播放列表反复重试 */
    fun clear() {
        synchronized(cache) { cache.clear() }
    }

    private fun isFresh(url: String): Boolean = synchronized(cache) {
        val entry = cache[url] ?: return false
        System.currentTimeMillis() - entry.at <= TTL_MS
    }

    /** 与 ExoPlayer 侧 dataSpec.uri.toString() 对齐：同一个地址的不同写法（转义差异）归一到同一个 key */
    private fun keyOf(url: String): String = try {
        Uri.parse(url).toString()
    } catch (_: Exception) {
        url
    }

    private fun isPlaylistUrl(url: String): Boolean {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false
        // 采集源绝大多数用 .m3u8 结尾；也放行 URL 里带 m3u8 的（/index.m3u8?token=…、/play/m3u8/…）
        return url.contains("m3u8", ignoreCase = true) || try {
            Uri.parse(url).path?.endsWith(".m3u8", ignoreCase = true) == true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * 拉一份播放列表并缓存；[depth] == 0 时若判定为 master playlist，顺带把第一路子
     * playlist 也拉热（ExoPlayer 解析完 master 后会立刻请求它）。
     */
    private fun fetch(target: String, depth: Int): Boolean {
        val key = keyOf(target)
        val (body, finalUrl) = download(target) ?: return false
        // 200 + HTML 错误页 / 验证页不能缓存：原样交给播放器去请求，它至少能报出真实错误
        if (!looksLikePlaylist(body)) return false
        val now = System.currentTimeMillis()
        val entry = Playlist(body, finalUrl, now)
        synchronized(cache) {
            cache[key] = entry
            // 重定向目标也存一份：播放列表内部引用它时同样能命中
            val finalKey = keyOf(finalUrl)
            if (finalKey != key) cache[finalKey] = entry
        }

        if (depth == 0) {
            val text = body.toString(Charsets.UTF_8)
            if (text.contains("#EXT-X-STREAM-INF")) {
                firstVariantUrl(text, finalUrl)?.let { variant ->
                    if (!isFresh(keyOf(variant))) {
                        try {
                            fetch(variant, depth + 1)
                        } catch (_: Exception) {
                            // 子 playlist 预热失败无所谓
                        }
                    }
                }
            }
        }
        return true
    }

    private fun looksLikePlaylist(body: ByteArray): Boolean {
        val head = body.toString(Charsets.UTF_8).trimStart('\uFEFF', '\n', '\r', ' ', '\t')
        return head.startsWith("#EXTM3U")
    }

    /** 读回播放列表原始字节 + 最终地址；失败返回 null */
    private fun download(target: String): Pair<ByteArray, String>? {
        var current = target
        var redirects = 0
        while (true) {
            val conn = URL(current).openConnection() as HttpURLConnection
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.instanceFollowRedirects = true
            conn.useCaches = false
            conn.setRequestProperty("User-Agent", ProxyHandler.USER_AGENT)
            conn.setRequestProperty("Accept", "*/*")
            // 与 DefaultHttpDataSource 一致：不协商压缩。拿到压缩字节喂给播放器会解析失败，
            // 所以万一对端仍返回了 Content-Encoding，下面会直接放弃这次预热。
            conn.setRequestProperty("Accept-Encoding", "identity")

            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location")
                conn.disconnect()
                if (location == null || redirects >= MAX_REDIRECTS) return null
                current = try {
                    URL(URL(current), location).toString()
                } catch (_: Exception) {
                    return null
                }
                redirects++
                continue
            }
            if (code !in 200..299) {
                conn.disconnect()
                return null
            }

            val encoding = conn.contentEncoding
            if (!encoding.isNullOrEmpty() && !encoding.equals("identity", ignoreCase = true)) {
                conn.disconnect()
                return null
            }
            // 明确声明超大的就不是播放列表，别为一棵歪脖子树把内存占了
            if (conn.contentLengthLong > MAX_PLAYLIST_BYTES) {
                conn.disconnect()
                return null
            }

            // 读完就关流（不要 disconnect）：socket 才能回到 keep-alive 池给分片请求复用
            val bytes = conn.inputStream.use { readCapped(it) }
            if (bytes == null) {
                conn.disconnect()
                return null
            }
            return bytes to conn.url.toString()
        }
    }

    private fun readCapped(input: InputStream): ByteArray? {
        val out = ByteArrayOutputStream(16 * 1024)
        val buf = ByteArray(32 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > MAX_PLAYLIST_BYTES) return null
        }
        return out.toByteArray()
    }

    /** master playlist 里第一路码流的地址（#EXT-X-STREAM-INF 下一行的非注释行） */
    private fun firstVariantUrl(content: String, baseUrl: String): String? {
        var expectUri = false
        for (raw in content.split('\n')) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            if (expectUri) {
                if (line.startsWith("#")) continue
                return try {
                    val resolved = java.net.URI(baseUrl).resolve(line).toString()
                    if (resolved.startsWith("http://") || resolved.startsWith("https://")) resolved else null
                } catch (_: Exception) {
                    null
                }
            }
            if (line.startsWith("#EXT-X-STREAM-INF")) expectUri = true
        }
        return null
    }
}
