// 单个源搜索超时，取自 config.js 的聚合搜索配置。
// 略大于服务端 REQUEST_TOTAL_TIMEOUT：让服务端先返回超时，避免客户端先断开让服务端白做。
const SEARCH_TIMEOUT = (typeof AGGREGATED_SEARCH_CONFIG !== 'undefined' && AGGREGATED_SEARCH_CONFIG.timeout) || 6000;

// ============================================================
//  源健康熔断（客户端层）
//  某个源连续失败后，一段时间内直接跳过，连请求都不发 ——
//  像“证书过期”“403 防盗链”这类死源否则每次搜索都要白白等一个超时。
// ============================================================
// 键名带 v2：避免旧的、误判过的健康记录把用户锁在“只剩一个源”
const SOURCE_HEALTH_KEY = 'sourceHealth_v2';
const SOURCE_FAIL_THRESHOLD = 3;
const SOURCE_COOLDOWN_MS = 5 * 60 * 1000;

// 只有“这个源确实坏了”才判失败、进冷却。超时/熔断 503/临时 5xx 只是慢或瞬时，
// 不能把还能用的源判死 —— 这正是之前“搜出来只剩一个播放源”的元凶。
const HARD_FAILURE_BODY = /certificate|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/i;
function isHardSourceFailure(status, body) {
    if (status === 401) return false;   // 本站鉴权失败，不是采集源的问题
    if (status === 403) return true;    // 上游封禁 / 防盗链
    return HARD_FAILURE_BODY.test(body || '');
}

function getSourceHealthMap() {
    try {
        const m = JSON.parse(localStorage.getItem(SOURCE_HEALTH_KEY) || '{}');
        return m && typeof m === 'object' ? m : {};
    } catch (e) {
        return {};
    }
}

function saveSourceHealthMap(m) {
    try { localStorage.setItem(SOURCE_HEALTH_KEY, JSON.stringify(m)); } catch (e) {}
}

function isSourceAvailable(apiId) {
    const h = getSourceHealthMap()[apiId];
    return !h || !h.until || h.until <= Date.now();
}

function recordSourceOutcome(apiId, ok) {
    const m = getSourceHealthMap();
    if (ok) {
        if (m[apiId]) { delete m[apiId]; saveSourceHealthMap(m); }
        return;
    }
    const h = m[apiId] || { fails: 0, until: 0 };
    h.fails = (h.fails || 0) + 1;
    if (h.fails >= SOURCE_FAIL_THRESHOLD) {
        h.until = Date.now() + SOURCE_COOLDOWN_MS;
        h.fails = 0;
    }
    m[apiId] = h;
    saveSourceHealthMap(m);
}

function resetSourceHealth() {
    try { localStorage.removeItem(SOURCE_HEALTH_KEY); } catch (e) {}
}

// 供设置页/调试查看
window.sourceHealth = { isSourceAvailable, getSourceHealthMap, resetSourceHealth };

// ============================================================
//  搜索结果缓存（客户端层）
//  同一 源+关键词 5 分钟内不重复请求；重搜/来回切换立刻出结果。
//  空结果也缓存，但 TTL 短得多，免得把“暂时没搜到”钉死太久。
// ============================================================
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const SEARCH_CACHE_EMPTY_TTL = 60 * 1000;
const SEARCH_CACHE_MAX = 300;
const searchCache = new Map();   // `${apiId}|${query}` -> { list, ts, ttl }

function readSearchCache(key) {
    const hit = searchCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > hit.ttl) { searchCache.delete(key); return null; }
    return hit.list.map(i => ({ ...i }));   // 浅拷贝，避免调用方改到缓存
}

function writeSearchCache(key, list) {
    if (searchCache.size >= SEARCH_CACHE_MAX) {
        // 简单的 FIFO 淘汰：Map 迭代顺序即插入顺序
        const oldest = searchCache.keys().next().value;
        if (oldest !== undefined) searchCache.delete(oldest);
    }
    searchCache.set(key, {
        list: list.map(i => ({ ...i })),
        ts: Date.now(),
        ttl: list.length ? SEARCH_CACHE_TTL : SEARCH_CACHE_EMPTY_TTL
    });
}

// 把「外部取消信号」（新一轮搜索 / 返回键 / 切换详情）和「本次请求超时」都接到同一个
// controller 上返回。要点：外部取消必须真的 abort 掉 fetch —— 只丢弃结果的话旧请求仍占着
// 同源连接（浏览器对单 origin 只有 ~6 条），新一轮搜索就得排队等它，这正是搜索要等好几分钟的直接原因。
function linkedAbortController(externalSignal, timeoutMs) {
    const controller = new AbortController();
    let timer = null;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', onExternalAbort);
    }
    if (timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
        signal: controller.signal,
        cleanup() {
            if (timer) { clearTimeout(timer); timer = null; }
            if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
        }
    };
}

function isAbortError(error) {
    return !!error && (error.name === 'AbortError' || error.code === 20);
}

// 给代理 URL 附加鉴权参数
async function withProxyAuth(url) {
    return window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
        ? window.ProxyAuth.addAuthToProxyUrl(url)
        : url;
}

async function searchByAPIAndKeyWord(apiId, query, externalSignal) {
    // 这一轮已经被取消了、或该源正在冷却，就别再发请求
    if (externalSignal && externalSignal.aborted) return [];
    if (!isSourceAvailable(apiId)) return [];

    try {
        let apiUrl, apiName, apiBaseUrl, apiUrlForItem;

        // 处理自定义API
        if (apiId.startsWith('custom_')) {
            const customIndex = apiId.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) return [];

            apiBaseUrl = customApi.url;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = customApi.name;
            apiUrlForItem = customApi.url;
        } else {
            // 内置API
            if (!API_SITES[apiId]) return [];
            apiBaseUrl = API_SITES[apiId].api;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = API_SITES[apiId].name;
            apiUrlForItem = undefined;
        }

        const cacheKey = apiId + '|' + query;
        const cached = readSearchCache(cacheKey);
        if (cached) return cached;

        const toResults = (list) => list.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: apiUrlForItem
        }));

        // 首页请求：超时和外部取消共用一个 controller，finally 里务必 cleanup，避免定时器泄漏
        const first = linkedAbortController(externalSignal, SEARCH_TIMEOUT);
        try {
            const proxiedUrl = await withProxyAuth(PROXY_URL + encodeURIComponent(apiUrl));
            const response = await fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers,
                signal: first.signal
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                if (isHardSourceFailure(response.status, body)) recordSourceOutcome(apiId, false);
                return [];
            }

            const data = await response.json();
            if (!data || !Array.isArray(data.list)) {
                recordSourceOutcome(apiId, false);   // 200 但返回的不是有效 API 数据 = 源有问题
                return [];
            }

            recordSourceOutcome(apiId, true);
            const results = toResults(data.list);

            // 分页：maxPages 默认 1，正常情况下这里会直接返回，不再扇出额外请求
            const pageCount = data.pagecount || 1;
            const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);
            if (pagesToFetch <= 0) {
                writeSearchCache(cacheKey, results);
                return results;
            }

            const additionalPagePromises = [];
            for (let page = 2; page <= pagesToFetch + 1; page++) {
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);

                additionalPagePromises.push((async () => {
                    const req = linkedAbortController(externalSignal, SEARCH_TIMEOUT);
                    try {
                        const proxiedPageUrl = await withProxyAuth(PROXY_URL + encodeURIComponent(pageUrl));
                        const pageResponse = await fetch(proxiedPageUrl, {
                            headers: API_CONFIG.search.headers,
                            signal: req.signal
                        });
                        if (!pageResponse.ok) return [];

                        const pageData = await pageResponse.json();
                        if (!pageData || !Array.isArray(pageData.list)) return [];

                        return toResults(pageData.list);
                    } catch (error) {
                        if (!isAbortError(error)) console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                        return [];
                    } finally {
                        req.cleanup();
                    }
                })());
            }

            const additionalResults = await Promise.all(additionalPagePromises);
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) results.push(...pageResults);
            });

            writeSearchCache(cacheKey, results);
            return results;
        } finally {
            first.cleanup();
        }
    } catch (error) {
        // 主动取消不算失败，别刷 console，也别记健康失败
        if (!isAbortError(error)) {
            console.warn(`API ${apiId} 搜索失败:`, error);
            recordSourceOutcome(apiId, false);
        }
        return [];
    }
}
