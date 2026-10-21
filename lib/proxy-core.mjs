// lib/proxy-core.mjs
//
// Serverless / Edge 代理的共享核心，行为对齐 server.mjs 的 /proxy/：
//   - UA 伪装、豆瓣图床 Referer
//   - 单次请求超时 + 总时间预算 + 只重试瞬时错误
//   - 按 host 熔断（含半开）+ 上游并发上限
//   - 敏感响应头过滤、二进制原样透传（不再 text() 破坏图片）
//   - m3u8 原样透传（与 server.mjs 一致，不在代理层改写/降码率）
//
// 只使用 Web 标准 API（fetch / AbortController / crypto.subtle / TextEncoder），
// 因此 Node 18+（Vercel / Netlify）和 Cloudflare Workers 都能直接复用。

const RETRYABLE_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED',
    'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET',
]);
const FATAL_CODES = new Set([
    'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const HARD_HOST_FAILURES = new Set([
    'ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const FILTERED_HEADERS = new Set([
    'content-security-policy', 'cookie', 'set-cookie', 'x-frame-options',
    'access-control-allow-origin', 'content-encoding', 'content-length',
    'transfer-encoding', 'connection',
]);

const MAX_BODY_BYTES = 20 * 1024 * 1024;   // 代理只走图片/JSON/m3u8，视频分片不经过这里
const AUTH_MAX_AGE_MS = 10 * 60 * 1000;

// 模块级状态：在同一个 Lambda/Worker 实例内共享；跨实例不共享，属于尽力而为的熔断。
const breakers = new Map();   // host -> { fails, openUntil, probing }
let activeUpstream = 0;
const upstreamQueue = [];
let maxUpstreamSeen = 16;

function intEnv(env, key, fallback) {
    const n = parseInt(env[key], 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function positiveIntEnv(env, key, fallback) {
    const n = parseInt(env[key], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function csvEnv(env, key, fallback) {
    const raw = env[key] == null ? fallback : env[key];
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function readConfig(env) {
    return {
        password: env.PASSWORD || '',
        timeout: positiveIntEnv(env, 'REQUEST_TIMEOUT', 8000),
        totalTimeout: positiveIntEnv(env, 'REQUEST_TOTAL_TIMEOUT', 10000),
        maxRetries: intEnv(env, 'MAX_RETRIES', 2),
        maxUpstream: positiveIntEnv(env, 'MAX_UPSTREAM_CONCURRENCY', 16),
        breakerThreshold: positiveIntEnv(env, 'BREAKER_THRESHOLD', 4),
        breakerCooldown: positiveIntEnv(env, 'BREAKER_COOLDOWN', 60) * 1000,
        userAgent: env.USER_AGENT ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        debug: env.DEBUG === 'true',
        blockedHosts: new Set(csvEnv(env, 'BLOCKED_HOSTS', 'localhost,127.0.0.1,0.0.0.0,::1,[::1]')),
        blockedPrefixes: csvEnv(env, 'BLOCKED_IP_PREFIXES', '192.168.,10.,172.'),
    };
}

function log(cfg, ...args) {
    if (cfg.debug) console.log('[VelioraProxy]', ...args);
}

// ---------- 鉴权 ----------

let cachedPassword = '';
let cachedPasswordHash = '';

async function sha256Hex(text) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new Error('当前运行时缺少 crypto.subtle，无法校验代理鉴权');
    }
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(text)
    );
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function validateAuth(auth, timestamp, cfg) {
    if (!cfg.password) return false;
    if (!auth) return false;
    if (cachedPassword !== cfg.password) {
        cachedPasswordHash = await sha256Hex(cfg.password);
        cachedPassword = cfg.password;
    }
    if (auth !== cachedPasswordHash) return false;
    if (timestamp) {
        const t = parseInt(timestamp, 10);
        if (!Number.isFinite(t) || Date.now() - t > AUTH_MAX_AGE_MS) return false;
    }
    return true;
}

export function decodeTargetUrl(encodedPath) {
    if (!encodedPath) return '';
    let decoded = '';
    try { decoded = decodeURIComponent(encodedPath); }
    catch { decoded = String(encodedPath); }
    return /^https?:\/\//i.test(decoded) ? decoded : '';
}

function isValidTargetUrl(targetUrl, cfg) {
    let u;
    try { u = new URL(targetUrl); }
    catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (cfg.blockedHosts.has(host)) return false;
    return !cfg.blockedPrefixes.some(prefix => host.startsWith(prefix));
}

// ---------- host 熔断 ----------

function hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
}

function breakerAllow(host) {
    const b = breakers.get(host);
    if (!b) return true;
    if (b.openUntil && Date.now() < b.openUntil) return false;
    if (b.openUntil) {
        if (b.probing) return false;
        b.probing = true;
    }
    return true;
}

function breakerReleaseProbe(host) {
    const b = host && breakers.get(host);
    if (b) b.probing = false;
}

function breakerDone(host, ok, cfg) {
    const b = breakers.get(host);
    if (ok) {
        if (b) breakers.delete(host);
        return;
    }
    const cur = b || { fails: 0, openUntil: 0, probing: false };
    cur.fails += 1;
    cur.probing = false;
    if (cur.fails >= cfg.breakerThreshold) {
        cur.openUntil = Date.now() + cfg.breakerCooldown;
        cur.fails = 0;
        log(cfg, `熔断 host ${host}，冷却 ${cfg.breakerCooldown / 1000}s`);
    }
    breakers.set(host, cur);
}

// ---------- 上游并发 ----------

function acquireUpstream(max) {
    maxUpstreamSeen = max;
    if (activeUpstream < maxUpstreamSeen) {
        activeUpstream++;
        return Promise.resolve();
    }
    return new Promise(resolve => upstreamQueue.push(resolve));
}

function releaseUpstream() {
    const next = upstreamQueue.shift();
    if (next) next();
    else activeUpstream--;
}

// ---------- 请求与重试 ----------

function networkErrorInfo(error) {
    const cause = error && error.cause ? error.cause : error;
    return {
        code: (cause && cause.code) || (error && error.code) || '',
        message: String((error && error.message) || '') + ' ' +
            String((cause && cause.message) || ''),
    };
}

function isRetryableNetworkError(error) {
    if (error && error.name === 'AbortError') return true;   // 单次请求超时
    const { code, message } = networkErrorInfo(error);
    if (code && FATAL_CODES.has(code)) return false;
    if (code && RETRYABLE_CODES.has(code)) return true;
    return /socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|timeout|fetch failed/i
        .test(message);
}

function isBreakerWorthy(error, status) {
    if (status) return status === 401 || status === 403;
    if (!error) return false;
    const { code } = networkErrorInfo(error);
    return HARD_HOST_FAILURES.has(code);
}

function upstreamHeaders(targetUrl, cfg) {
    const headers = { 'user-agent': cfg.userAgent };
    // 豆瓣图片 CDN 有防盗链，必须带对应 Referer，否则返回 418
    if (/doubanio\.com/i.test(targetUrl)) {
        headers['referer'] = 'https://movie.douban.com/';
    }
    return headers;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(targetUrl, cfg, method) {
    const deadline = Date.now() + cfg.totalTimeout;
    let lastError = null;

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            const err = new Error(`代理请求超时（总预算 ${cfg.totalTimeout}ms）`);
            err.code = 'ETIMEDOUT_TOTAL';
            throw err;
        }

        const controller = new AbortController();
        // 计时器要覆盖「拿响应头 + 读响应体」全过程，否则上游发完头就挂住时
        // arrayBuffer() 会一直等到平台超时。
        const timer = setTimeout(
            () => controller.abort(),
            Math.min(cfg.timeout, remaining)
        );
        try {
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: upstreamHeaders(targetUrl, cfg),
                redirect: 'follow',
                signal: controller.signal,
            });

            // 429 / 5xx 是瞬时/被限流，值得退避重试；4xx 一律不重试
            if ((response.status === 429 || response.status >= 500) &&
                attempt < cfg.maxRetries) {
                try { await response.body?.cancel(); } catch {}
                lastError = Object.assign(new Error(`上游 HTTP ${response.status}`), {
                    status: response.status,
                });
            } else {
                const body = method === 'HEAD'
                    ? new Uint8Array(0)
                    : await readBody(response, cfg);
                return { response, body };
            }
        } catch (error) {
            lastError = error;
            if (!isRetryableNetworkError(error) || attempt >= cfg.maxRetries) throw error;
        } finally {
            clearTimeout(timer);
        }

        const delay = Math.min(150 * Math.pow(2, attempt), 800) +
            Math.floor(Math.random() * 100);
        if (Date.now() + delay >= deadline) break;
        log(cfg, `重试请求 (${attempt + 1}/${cfg.maxRetries}, ${delay}ms 后): ${targetUrl}`);
        await sleep(delay);
    }

    throw lastError || new Error('代理请求失败');
}

// ---------- 响应 ----------

function textResponse(status, message, extraHeaders = {}) {
    const body = new TextEncoder().encode(`请求失败: ${message}`);
    return {
        status,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': String(body.byteLength),
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': '*',
            ...extraHeaders,
        },
        body,
    };
}

function responseHeaders(upstream, bodyLength) {
    const headers = {};
    upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (FILTERED_HEADERS.has(lower) || lower.startsWith('access-control-')) return;
        headers[lower] = value;
    });
    headers['content-length'] = String(bodyLength);
    if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-methods'] = 'GET, HEAD, OPTIONS';
    headers['access-control-allow-headers'] = '*';
    return headers;
}

async function readBody(response, cfg) {
    const declared = parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        try { await response.body?.cancel(); } catch {}
        throw Object.assign(new Error('响应体过大'), { code: 'BODY_TOO_LARGE', status: 502 });
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BODY_BYTES) {
        throw Object.assign(new Error('响应体过大'), { code: 'BODY_TOO_LARGE', status: 502 });
    }
    return buffer;
}

function statusForError(error) {
    const code = error && error.code;
    if (code === 'ETIMEDOUT_TOTAL') return 504;
    if (error && error.name === 'AbortError') return 504;
    return 502;
}

/**
 * 处理一次代理请求。
 *
 * @param {object} opts
 * @param {string} opts.targetUrl 已解码的目标 URL
 * @param {string} [opts.auth]   前端带来的密码哈希
 * @param {string} [opts.timestamp] 前端带来的时间戳
 * @param {object} [opts.env]    环境变量（Node 传 process.env，Cloudflare 传 env）
 * @param {string} [opts.method] 只支持 GET / HEAD
 * @returns {Promise<{status:number, headers:Record<string,string>, body:Uint8Array}>}
 */
export async function handleProxyRequest({
    targetUrl,
    auth,
    timestamp,
    env = {},
    method = 'GET',
} = {}) {
    const cfg = readConfig(env);

    if (method !== 'GET' && method !== 'HEAD') {
        return textResponse(405, '只支持 GET / HEAD');
    }

    if (!(await validateAuth(auth, timestamp, cfg))) {
        return textResponse(401, '代理访问未授权：请检查密码配置或鉴权参数');
    }

    if (!targetUrl || !isValidTargetUrl(targetUrl, cfg)) {
        return textResponse(400, '无效的 URL');
    }

    const host = hostOf(targetUrl);
    if (host && !breakerAllow(host)) {
        return textResponse(503, `上游 ${host} 近期连续失败，已临时熔断`, {
            'retry-after': String(Math.ceil(cfg.breakerCooldown / 1000)),
        });
    }

    await acquireUpstream(cfg.maxUpstream);
    try {
        const { response, body } = await fetchWithRetry(targetUrl, cfg, method);

        if (response.status === 401 || response.status === 403) {
            if (host) breakerDone(host, false, cfg);
        } else if (response.ok) {
            if (host) breakerDone(host, true, cfg);
        } else {
            if (host) breakerReleaseProbe(host);
        }

        return {
            status: response.status,
            headers: responseHeaders(response, body.byteLength),
            body,
        };
    } catch (error) {
        if (host) {
            if (isBreakerWorthy(error, error && error.status)) {
                breakerDone(host, false, cfg);
            } else {
                breakerReleaseProbe(host);
            }
        }
        log(cfg, `代理失败: ${targetUrl} | ${error && error.message}`);
        return textResponse(statusForError(error), (error && error.message) || '代理请求失败');
    } finally {
        releaseUpstream();
    }
}
