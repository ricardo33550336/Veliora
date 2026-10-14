package org.veliora.television

import android.net.Uri
import android.util.Log
import android.webkit.WebResourceResponse
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URLDecoder
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

/**
 * 原生实现 server.mjs 的 /proxy/<encodeURIComponent(url)> 端点。
 * 行为对齐 server.mjs：UA 伪装、豆瓣图床 Referer、敏感响应头过滤，以及
 * 「重试分类 / 总时间预算 / host 熔断 / 客户端断开即中止上游 / 连接池复用」那一套。
 * 本地 App 内部信任，跳过 auth 参数校验（server.mjs 的密码鉴权是为公网部署设计的）。
 */
class ProxyHandler {

    companion object {
        private const val TAG = "VelioraProxy"

        // 与 server.mjs config.userAgent 一致
        const val USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"

        // server.mjs BLOCKED_HOSTS / BLOCKED_IP_PREFIXES 同款默认值
        private val BLOCKED_HOSTS = setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")
        private val BLOCKED_IP_PREFIXES = listOf("192.168.", "10.", "172.")

        // server.mjs FILTERED_HEADERS + WebView 不适用的传输层头
        private val FILTERED_HEADERS = setOf(
            "content-security-policy", "cookie", "set-cookie",
            "x-frame-options", "access-control-allow-origin",
            "content-encoding", "content-length", "transfer-encoding", "connection"
        )

        // ---- 对齐 server.mjs 的请求策略 ----
        // 单个代理请求的总时间预算：所有重试加起来不超过它（server.mjs REQUEST_TOTAL_TIMEOUT）
        private const val TOTAL_TIMEOUT_MS = 10_000L
        private const val CONNECT_TIMEOUT_MS = 5_000L
        private const val READ_TIMEOUT_MS = 8_000L
        private const val MAX_RETRIES = 2
        // 只有“秒失败”才重试：慢着慢着才失败的再重试只会把等待翻倍
        private const val FAST_FAILURE_MS = 2_000L
        private const val BACKOFF_BASE_MS = 150L
        private const val BACKOFF_MAX_MS = 800L

        // host 熔断：连续硬失败达阈值就短路，冷却后只放一个探测（半开）
        private const val BREAKER_THRESHOLD = 4
        private const val BREAKER_COOLDOWN_MS = 60_000L

        // 上游并发上限（同 server.mjs MAX_UPSTREAM_CONCURRENCY）。
        // 拿不到名额也照发，只是不额外排队，避免阻塞 WebView 的拦截线程。
        private const val MAX_UPSTREAM = 16

        private val RETRYABLE_MSG = Regex(
            "ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|timeout",
            RegexOption.IGNORE_CASE
        )
    }

    private class Breaker(var fails: Int = 0, var openUntil: Long = 0L, var probing: Boolean = false)

    private val breakers = ConcurrentHashMap<String, Breaker>()
    private val upstreamSlots = Semaphore(MAX_UPSTREAM, true)

    private val client = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        // 整次调用的硬上限（含重定向）——对应 server.mjs 的总预算
        .callTimeout(TOTAL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .connectionPool(ConnectionPool(8, 5, TimeUnit.MINUTES))
        .followRedirects(true)
        .followSslRedirects(true)
        // 连接层的路由重试（换 IP 重连），不重试 4xx/5xx
        .retryOnConnectionFailure(true)
        .build()

    // ---------- host 熔断 ----------

    private fun breakerAllow(host: String): Boolean {
        val b = breakers[host] ?: return true
        synchronized(b) {
            val now = System.currentTimeMillis()
            if (b.openUntil > 0 && now < b.openUntil) return false      // 熔断中
            if (b.openUntil > 0) {                                      // 冷却结束：半开
                if (b.probing) return false
                b.probing = true
            }
        }
        return true
    }

    private fun breakerSuccess(host: String) {
        breakers.remove(host)
    }

    private fun breakerFailure(host: String) {
        val b = breakers.getOrPut(host) { Breaker() }
        synchronized(b) {
            b.fails++
            b.probing = false
            if (b.fails >= BREAKER_THRESHOLD) {
                b.openUntil = System.currentTimeMillis() + BREAKER_COOLDOWN_MS
                b.fails = 0
                Log.i(TAG, "熔断 host $host，冷却 ${BREAKER_COOLDOWN_MS / 1000}s")
            }
        }
    }

    /** 客户端提前断开 / 不可归类的结果：不算故障，但要把半开探测标记放回去 */
    private fun breakerReleaseProbe(host: String?) {
        if (host == null) return
        breakers[host]?.let { synchronized(it) { it.probing = false } }
    }

    private fun isHardHostException(e: Exception): Boolean =
        e is UnknownHostException || e is ConnectException || e is SSLException

    /**
     * 让错误体与 server.mjs 的文案对齐，这样前端 isHardSourceFailure 的同一个正则
     * （certificate / ENOTFOUND / ECONNREFUSED）在 App 里也能命中，两层熔断判断一致。
     * 超时不加任何关键词 —— 慢 ≠ 坏。
     */
    private fun errorBodyFor(e: Exception): String = when (e) {
        is UnknownHostException -> "代理请求失败: ENOTFOUND ${e.message}"
        is SSLException -> "代理请求失败: certificate ${e.message}"
        is ConnectException -> "代理请求失败: ECONNREFUSED ${e.message}"
        else -> "代理请求失败: ${e.message}"
    }

    private fun isRetryable(e: IOException): Boolean = when (e) {
        is UnknownHostException -> false     // DNS 找不到是永久的
        is SSLException -> false             // 证书问题重试无意义
        is SocketTimeoutException -> true
        is ConnectException -> true
        else -> RETRYABLE_MSG.containsMatchIn(e.message ?: "")
    }

    // ---------- 主入口 ----------

    fun handle(uri: Uri): WebResourceResponse {
        val target: String
        try {
            // 必须用 encodedPath：目标 URL 的 ?& 等字符以百分号编码存在于路径段中
            val encoded = uri.encodedPath?.removePrefix("/proxy/") ?: ""
            target = URLDecoder.decode(encoded, "UTF-8")
        } catch (e: Exception) {
            return errorResponse(400, "无效的代理路径")
        }

        if (!isValidUrl(target)) {
            return errorResponse(400, "无效或被禁止的目标 URL")
        }

        val host = hostOf(target)
        if (host != null && !breakerAllow(host)) {
            return errorResponse(503, "上游 $host 近期连续失败，已临时熔断")
        }

        var acquired = false
        try {
            acquired = upstreamSlots.tryAcquire(2, TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }

        try {
            return executeWithRetry(target, host)
        } catch (e: Exception) {
            // 记账已在 executeWithRetry 内完成，这里只负责回错误。
            // 错误体里带上 JS 侧能识别的字样，让「客户端源熔断」也判得准。
            Log.w(TAG, "代理请求失败: $target", e)
            return errorResponse(502, errorBodyFor(e))
        } finally {
            if (acquired) upstreamSlots.release()
        }
    }

    /**
     * 带总预算 + 错误分类重试的执行。
     * 只在“瞬时且秒失败”时重试；证书过期 / DNS 找不到 / 403 直接放弃并记入熔断。
     */
    private fun executeWithRetry(target: String, host: String?): WebResourceResponse {
        val reqBuilder = Request.Builder()
            .url(target)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "*/*")
        // 豆瓣图片 CDN 有防盗链，需带对应 Referer，否则返回 418（对齐 server.mjs）
        if (target.contains("doubanio.com")) {
            reqBuilder.header("Referer", "https://movie.douban.com/")
        }
        val req = reqBuilder.build()

        val deadline = System.currentTimeMillis() + TOTAL_TIMEOUT_MS
        var attempt = 0
        var backoff = BACKOFF_BASE_MS
        var lastError: Exception? = null

        while (true) {
            val started = System.currentTimeMillis()
            if (started >= deadline) break
            attempt++

            try {
                val call = client.newCall(req)
                val resp = call.execute()

                // 5xx / 429 可重试；重试次数用尽后按最终结果返回
                if ((resp.code == 429 || resp.code >= 500) && attempt <= MAX_RETRIES) {
                    lastError = IOException("HTTP ${resp.code}")
                    resp.close()
                } else {
                    accountBreaker(host, resp)
                    return buildResponse(resp, call)
                }
            } catch (e: IOException) {
                lastError = e
                val elapsed = System.currentTimeMillis() - started
                val canRetry = isRetryable(e) && elapsed < FAST_FAILURE_MS &&
                    attempt <= MAX_RETRIES && System.currentTimeMillis() < deadline
                if (!canRetry) {
                    if (host != null) {
                        if (isHardHostException(e)) breakerFailure(host) else breakerReleaseProbe(host)
                    }
                    throw e
                }
            } catch (e: Exception) {
                breakerReleaseProbe(host)
                throw e
            }

            // 退避后重试，且必须留在总预算内
            if (System.currentTimeMillis() + backoff >= deadline) break
            try {
                Thread.sleep(backoff)
            } catch (ie: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
            backoff = minOf(backoff * 2, BACKOFF_MAX_MS)
        }

        breakerReleaseProbe(host)
        throw SocketTimeoutException(lastError?.message ?: "代理请求超时（总预算 ${TOTAL_TIMEOUT_MS}ms）")
    }

    private fun accountBreaker(host: String?, resp: Response) {
        if (host == null) return
        when {
            resp.isSuccessful -> breakerSuccess(host)
            resp.code == 401 || resp.code == 403 -> breakerFailure(host)
            else -> breakerReleaseProbe(host)
        }
    }

    private fun buildResponse(resp: Response, call: Call): WebResourceResponse {
        val body = resp.body
        if (body == null) {
            resp.close()
            return errorResponse(502, "目标无响应体")
        }

        val contentType = body.contentType()
        val mime = contentType?.let { "${it.type}/${it.subtype}" } ?: "application/octet-stream"
        val charset = contentType?.charset()?.name()

        val headers = mutableMapOf<String, String>()
        for ((name, value) in resp.headers) {
            if (name.lowercase() !in FILTERED_HEADERS) headers[name] = value
        }
        headers["Access-Control-Allow-Origin"] = "*"

        // WebResourceResponse 不允许 3xx 状态码、空的或非 ASCII 的 reasonPhrase
        var code = resp.code
        if (code in 300..399) code = 502
        val reason = resp.message.ifBlank { "OK" }.let {
            if (it.all { c -> c.code in 32..126 }) it else "OK"
        }

        // 客户端（WebView）提前取消会 close 这个流 → 顺手 cancel 上游，别再空转
        return WebResourceResponse(
            mime, charset, code, reason, headers,
            CancelOnCloseInputStream(body.byteStream(), call)
        )
    }

    /**
     * 直接抓取文本（用于「从 URL 导入配置」）。
     * 这里不复用 isValidUrl：那个内网拦截是给公网代理防 SSRF 的，而此处目标是用户
     * 自己输入的地址（常是局域网静态服务器）。浏览器 fetch 会被 CORS 拦住，所以走原生。
     * 失败返回空串。
     */
    fun fetchText(target: String): String {
        if (!target.startsWith("http://") && !target.startsWith("https://")) return ""
        return try {
            // 导入配置可能较大，给比代理请求更宽的超时；newBuilder 共享连接池
            val c = client.newBuilder().callTimeout(20, TimeUnit.SECONDS).build()
            val req = Request.Builder()
                .url(target)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json, text/plain, */*")
                .build()
            c.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) "" else resp.body?.string() ?: ""
            }
        } catch (e: Exception) {
            Log.w(TAG, "fetchText 失败: $target", e)
            ""
        }
    }

    /** 对齐 server.mjs isValidUrl：仅 http/https，拦截本机与内网地址 */
    private fun isValidUrl(url: String): Boolean {
        val parsed = try {
            URI(url)
        } catch (e: Exception) {
            return false
        }
        if (parsed.scheme != "http" && parsed.scheme != "https") return false
        val host = parsed.host ?: return false
        if (host in BLOCKED_HOSTS) return false
        if (BLOCKED_IP_PREFIXES.any { host.startsWith(it) }) return false
        return true
    }

    private fun hostOf(url: String): String? = try {
        URI(url).host
    } catch (e: Exception) {
        null
    }

    private fun errorResponse(code: Int, message: String): WebResourceResponse {
        val json = """{"success":false,"error":"$message"}"""
        // reasonPhrase 需为 ASCII，中文信息放在 JSON body 里
        return WebResourceResponse(
            "application/json", "utf-8", code, "Proxy Error",
            mapOf("Access-Control-Allow-Origin" to "*"),
            ByteArrayInputStream(json.toByteArray(Charsets.UTF_8))
        )
    }

    /** 关闭即取消上游 call：WebView 中断请求时不会再让连接空转 */
    private class CancelOnCloseInputStream(
        delegate: InputStream,
        private val call: Call
    ) : FilterInputStream(delegate) {
        override fun close() {
            try {
                super.close()
            } finally {
                call.cancel()
            }
        }
    }
}
