/**
 * TVBOX 订阅管理器（订阅层，移植 LibreTV subscription-sync.ts + store.ts 的订阅语义）
 *
 * 设计原则：TVBOX 是「输入格式」，Veliora 的 customAPIs 是「内部格式」。
 * 解析与转换全部在本层完成，搜索 / 详情 / 播放等既有代码无需判断 type===1 / type===3。
 *
 * 关键行为：
 *   - 缓存优先：启动时先用「上次成功」缓存恢复源列表（同步，不阻塞 UI），再后台刷新；
 *   - 原子替换：刷新成功才写入缓存并替换「本订阅产生的源」，手工源与其他订阅永远保留；
 *   - 失败回退：网络 / JSON / 空结果等任何失败都不清空旧数据；
 *   - 单飞锁：同一订阅同一时间只有一个刷新请求（Promise lock），避免并发覆盖；
 *   - 每次打开自动刷新：默认 TTL=0，可通过 refreshTtlMinutes 配置。
 *
 * 存储键（唯一、带版本号；不污染既有 localStorage 键）：
 *   veliora_subscriptions_v1        订阅配置与状态
 *   veliora_subscription_cache_v1   每个订阅「上次成功」的归一化源列表
 *
 * 订阅源通过既有 customAPIs 机制落入 `custom_N`，并带 metadata：
 *   { sourceType:'subscription', subscriptionId, subscriptionUrl, originalKey, originalType }
 * 手工源不带 subscriptionId，因此两者可分别管理。
 */
(function () {
    'use strict';

    const SUB_KEY = 'veliora_subscriptions_v1';
    const CACHE_KEY = 'veliora_subscription_cache_v1';
    const CUSTOM_KEY = 'customAPIs';
    const SELECTED_KEY = 'selectedAPIs';
    const PROXY = (typeof PROXY_URL !== 'undefined') ? PROXY_URL : '/proxy/';
    const FETCH_TIMEOUT = 20000;

    // 同一订阅的进行中请求；value 为 Promise
    const inFlight = new Map();
    let autoRefreshStarted = false;
    let onChange = null;

    // ---------- localStorage 门面（与 tv-remote.js 的 store 同语义） ----------
    const store = {
        get(k, d) {
            try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; }
            catch (e) { return d; }
        },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    };

    function getCustomAPIs() {
        const list = store.get(CUSTOM_KEY, []);
        return Array.isArray(list) ? list : [];
    }
    function setCustomAPIs(list) { store.set(CUSTOM_KEY, list); }
    function getSelected() {
        const sel = store.get(SELECTED_KEY, []);
        return Array.isArray(sel) ? sel : [];
    }
    function setSelected(list) { store.set(SELECTED_KEY, list); }

    // ---------- 配置 / 缓存 ----------
    function loadConfig() {
        const cfg = store.get(SUB_KEY, null);
        if (cfg && typeof cfg === 'object' && Array.isArray(cfg.subscriptions)) {
            if (typeof cfg.refreshTtlMinutes !== 'number') cfg.refreshTtlMinutes = 0;
            if (typeof cfg.autoRefreshOnStartup !== 'boolean') cfg.autoRefreshOnStartup = true;
            return cfg;
        }
        return { version: 1, autoRefreshOnStartup: true, refreshTtlMinutes: 0, subscriptions: [] };
    }
    function saveConfig(cfg) {
        cfg.version = 1;
        store.set(SUB_KEY, cfg);
    }
    function loadCache() {
        const c = store.get(CACHE_KEY, null);
        return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
    }
    function saveCache(c) { store.set(CACHE_KEY, c); }

    // ---------- 工具 ----------
    function normalizeSubscriptionUrl(raw) {
        return String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
    }

    /** djb2 → base36，得到稳定且短的订阅 id */
    function subId(url) {
        let h = 5381;
        for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
        return 'sub_' + h.toString(36);
    }

    function hostOf(url) {
        try { return new URL(url).hostname; } catch (e) { return url; }
    }

    function normalizeUrlKey(url) {
        return String(url == null ? '' : url).trim().replace(/\/+$/, '');
    }

    /** 稳定身份：订阅源按「订阅 + 归一化 URL」，手工源按「归一化 URL」 */
    function identityOf(api) {
        const u = normalizeUrlKey(api && api.url);
        return (api && api.subscriptionId ? 's:' + api.subscriptionId + ':' : 'm:') + u;
    }

    function isSubscriptionEntry(api) {
        return !!(api && api.subscriptionId);
    }

    function notify() {
        try { if (typeof onChange === 'function') onChange(); } catch (e) {}
    }

    function friendlyError(err) {
        const msg = (err && err.message) ? String(err.message) : '未知错误';
        if (err && (err.name === 'AbortError' || /aborted|timeout/i.test(msg))) return '请求超时或被中断';
        if (/Failed to fetch|NetworkError|network/i.test(msg)) return '网络请求失败';
        return msg;
    }

    // ---------- 网络：优先直连（GitHub raw / gh-proxy 均带 CORS），失败回退项目代理 ----------
    async function buildProxyUrl(target) {
        const raw = PROXY + encodeURIComponent(target);
        try {
            if (window.ProxyAuth && typeof window.ProxyAuth.addAuthToProxyUrl === 'function') {
                return await window.ProxyAuth.addAuthToProxyUrl(raw);
            }
        } catch (e) {}
        return raw;
    }

    function fetchText(url) {
        return new Promise(function (resolve, reject) {
            const ctrl = new AbortController();
            const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
            fetch(url, {
                method: 'GET',
                signal: ctrl.signal,
                cache: 'no-store',
                mode: 'cors',
                headers: { 'Accept': 'application/json, text/plain, */*' },
            }).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            }).then(function (text) {
                clearTimeout(timer);
                resolve(text);
            }).catch(function (err) {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * 下载并解析订阅：整个 URL 字符串（如 gh-proxy 代理地址）原样请求，不做内部拆解。
     * 任一候选通道成功解析即返回；全部失败抛最后一个错误（调用方保留旧缓存）。
     */
    async function fetchSubscriptionPayload(url) {
        const candidates = [{ kind: 'direct', url: url }];
        try { candidates.push({ kind: 'proxy', url: await buildProxyUrl(url) }); } catch (e) {}

        let lastErr = null;
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            try {
                const text = await fetchText(c.url);
                if (!text || !text.trim()) throw new Error('返回内容为空');
                const json = window.VelioraTVBox.parseLenientJson(text);
                return { json: json, via: c.kind };
            } catch (e) {
                lastErr = e;
            }
        }
        throw (lastErr || new Error('订阅下载失败'));
    }

    // ---------- 源落库（原子替换本订阅产生的源） ----------
    /**
     * 用 list 整体替换 sub 产生的源：
     *   - 手工源与其他订阅源原样保留；
     *   - 本订阅旧源的勾选状态按 URL 对齐保留（用户停用的不会被刷新反复勾回）；
     *   - 新源默认自动勾选（黄色过滤开启时跳过成人源）。
     */
    function applySubscriptionSources(sub, list) {
        const oldApis = getCustomAPIs();
        const oldSelected = getSelected();
        const selectedKeys = new Set(oldSelected.filter(function (k) { return k.indexOf('custom_') === 0; }));

        const prevOwned = [];
        const kept = [];
        oldApis.forEach(function (api, i) {
            if (isSubscriptionEntry(api) && api.subscriptionId === sub.id) {
                prevOwned.push({ api: api, selected: selectedKeys.has('custom_' + i) });
            } else {
                kept.push(api);
            }
        });

        const prevUrlSet = new Set(prevOwned.map(function (x) { return identityOf(x.api); }));
        const prevSelectedSet = new Set(prevOwned
            .filter(function (x) { return x.selected; })
            .map(function (x) { return identityOf(x.api); }));

        const yellowOn = localStorage.getItem('yellowFilterEnabled') === 'true';
        const incoming = list.map(function (s) {
            return {
                name: s.name,
                url: s.url,
                detail: s.detail,
                isAdult: s.isAdult === true,
                sourceType: 'subscription',
                subscriptionId: sub.id,
                subscriptionUrl: sub.url,
                originalKey: s.originalKey,
                originalType: typeof s.originalType === 'number' ? s.originalType : 1,
            };
        });

        const newList = kept.concat(incoming);
        const firstNewIdx = kept.length;

        // 保留非 custom_ 的内置源勾选
        const nonCustomSelected = oldSelected.filter(function (k) { return k.indexOf('custom_') !== 0; });
        // 保留被 kept 的手工/其他订阅源勾选
        const keptSelectedKeys = [];
        for (let i = 0; i < kept.length; i++) {
            // kept[i] 在旧数组中的勾选状态已在 selectedKeys 里，按身份查
            const id = identityOf(kept[i]);
            const wasSelected = oldApis.some(function (api, oi) {
                return identityOf(api) === id && selectedKeys.has('custom_' + oi);
            });
            if (wasSelected) keptSelectedKeys.push('custom_' + i);
        }
        // 本订阅源的勾选：老源按 URL 对齐，新源按过滤规则自动勾选
        const subSelectedKeys = incoming.reduce(function (acc, s, i) {
            const id = identityOf(s);
            let select;
            if (prevUrlSet.has(id)) select = prevSelectedSet.has(id);
            else select = !yellowOn || !s.isAdult;
            if (select) acc.push('custom_' + (firstNewIdx + i));
            return acc;
        }, []);

        setCustomAPIs(newList);
        // 整个订阅被停用时，其源不参与搜索（数据仍保留，随时可无损恢复）
        setSelected(nonCustomSelected.concat(keptSelectedKeys, sub.enabled === false ? [] : subSelectedKeys));
        return incoming.length;
    }

    /** 启动时用缓存同步恢复（幂等）；cache 缺失/为空时绝不动现有源 */
    function reactivateFromCache(cfg) {
        const cache = loadCache();
        let restored = 0;
        cfg.subscriptions.forEach(function (sub) {
            if (sub.enabled === false) return;
            const c = cache[sub.id];
            if (c && Array.isArray(c.sources) && c.sources.length) {
                applySubscriptionSources(sub, c.sources);
                restored += c.sources.length;
            }
        });
        return restored;
    }

    // ---------- 刷新核心：自动 / 手动共用 ----------
    function findSub(idOrSub) {
        if (idOrSub && typeof idOrSub === 'object' && idOrSub.id) return idOrSub;
        const cfg = loadConfig();
        return cfg.subscriptions.find(function (s) { return s.id === idOrSub; }) || null;
    }

    async function doRefresh(sub, opts) {
        const manual = !!(opts && opts.manual);
        // 记录本次刷新时间并即时反馈到 UI
        var cfg = loadConfig();
        var meta = cfg.subscriptions.find(function (s) { return s.id === sub.id; });
        if (meta) { meta.lastRefreshAt = Date.now(); saveConfig(cfg); }
        notify();

        try {
            const payload = await fetchSubscriptionPayload(sub.url);
            const parsed = window.VelioraTVBox.parsePayload(payload.json);

            if (!parsed.sources || parsed.sources.length === 0) {
                // 解析结果为 0：视为异常，保留旧缓存，不清空
                const detail = window.VelioraTVBox.describeStats(parsed.stats);
                throw new Error('配置中没有可直接使用的 CMS 源' + (detail ? '（' + detail + '）' : ''));
            }

            // download → parse → validate → normalize → deduplicate → save cache → replace active sources
            const cache = loadCache();
            cache[sub.id] = {
                id: sub.id,
                url: sub.url,
                name: parsed.name,
                fetchedAt: Date.now(),
                via: payload.via,
                sources: parsed.sources,
                stats: parsed.stats,
            };
            saveCache(cache);
            applySubscriptionSources(sub, parsed.sources);

            var cfg2 = loadConfig();
            var m2 = cfg2.subscriptions.find(function (s) { return s.id === sub.id; });
            if (m2) {
                m2.name = parsed.name || m2.name || hostOf(sub.url);
                m2.enabled = m2.enabled !== false;
                m2.lastSuccessAt = Date.now();
                m2.lastError = null;
                m2.counts = {
                    total: parsed.stats.total,
                    imported: parsed.sources.length,
                    skipped: parsed.stats.skipped,
                    skippedByReason: parsed.stats.skippedByReason,
                };
                saveConfig(cfg2);
            }
            notify();
            return { ok: true, manual: manual, imported: parsed.sources.length, stats: parsed.stats };
        } catch (err) {
            var cfg3 = loadConfig();
            var m3 = cfg3.subscriptions.find(function (s) { return s.id === sub.id; });
            if (m3) {
                m3.lastRefreshAt = Date.now();
                m3.lastError = friendlyError(err);
                saveConfig(cfg3);
            }
            notify();
            throw err;
        }
    }

    /**
     * 刷新订阅（自动与手动共用同一核心函数）。
     * 同一订阅并发调用复用同一 Promise，绝不产生重复请求。
     */
    function refreshSubscription(idOrSub, opts) {
        const sub = findSub(idOrSub);
        if (!sub) return Promise.reject(new Error('订阅不存在'));
        if (inFlight.has(sub.id)) return inFlight.get(sub.id);
        const p = doRefresh(sub, opts).finally(function () {
            if (inFlight.get(sub.id) === p) inFlight.delete(sub.id);
            notify();   // 刷新结束后重渲染，清掉「正在刷新…」状态
        });
        inFlight.set(sub.id, p);
        return p;
    }

    function isRefreshing(id) {
        return id ? inFlight.has(id) : inFlight.size > 0;
    }

    // ---------- 订阅增删改 ----------
    function addSubscription(rawUrl, name) {
        const url = normalizeSubscriptionUrl(rawUrl);
        if (!/^https?:\/\/.+/i.test(url)) throw new Error('订阅地址需以 http:// 或 https:// 开头');
        try { new URL(url); } catch (e) { throw new Error('订阅地址格式不正确'); }
        const cfg = loadConfig();
        if (cfg.subscriptions.some(function (s) { return s.url === url; })) throw new Error('该订阅已存在');
        const sub = {
            id: subId(url),
            url: url,
            name: name || '',
            enabled: true,
            lastRefreshAt: 0,
            lastSuccessAt: 0,
            lastError: null,
            counts: null,
        };
        cfg.subscriptions.push(sub);
        saveConfig(cfg);
        notify();
        return sub;
    }

    function removeSubscription(id) {
        const cfg = loadConfig();
        cfg.subscriptions = cfg.subscriptions.filter(function (s) { return s.id !== id; });
        saveConfig(cfg);

        const cache = loadCache();
        if (cache[id]) { delete cache[id]; saveCache(cache); }

        // 只移除本订阅产生的源，手工源与其他订阅原样保留
        const oldApis = getCustomAPIs();
        const oldSelected = getSelected();
        const selectedKeys = new Set(oldSelected.filter(function (k) { return k.indexOf('custom_') === 0; }));
        const kept = [];
        const keptSelectedKeys = [];
        oldApis.forEach(function (api, i) {
            if (isSubscriptionEntry(api) && api.subscriptionId === id) return;
            const newIdx = kept.length;
            kept.push(api);
            if (selectedKeys.has('custom_' + i)) keptSelectedKeys.push('custom_' + newIdx);
        });
        setCustomAPIs(kept);
        setSelected(oldSelected
            .filter(function (k) { return k.indexOf('custom_') !== 0; })
            .concat(keptSelectedKeys));
        notify();
    }

    function setEnabled(id, enabled) {
        const cfg = loadConfig();
        const sub = cfg.subscriptions.find(function (s) { return s.id === id; });
        if (!sub) return;
        sub.enabled = !!enabled;
        saveConfig(cfg);

        // 停用：仅从搜索勾选移除；启用：重新勾选（数据始终保留在 customAPIs）
        const apis = getCustomAPIs();
        const sel = new Set(getSelected());
        apis.forEach(function (api, i) {
            if (!isSubscriptionEntry(api) || api.subscriptionId !== id) return;
            if (!enabled) { sel.delete('custom_' + i); return; }
            // 启用时重新勾选；黄色过滤开启时不自动勾选成人源
            const yellowOn = localStorage.getItem('yellowFilterEnabled') === 'true';
            if (!(yellowOn && api.isAdult === true)) sel.add('custom_' + i);
        });
        setSelected(Array.from(sel));
        notify();
    }

    // ---------- 查询（供 UI 使用） ----------
    function getSubscriptions() {
        return loadConfig().subscriptions.slice();
    }

    function getSubscription(id) {
        return loadConfig().subscriptions.find(function (s) { return s.id === id; }) || null;
    }

    /** 返回某订阅当前在 customAPIs 中的源（含 selected / key） */
    function getSubscriptionSources(id) {
        const apis = getCustomAPIs();
        const sel = new Set(getSelected());
        const out = [];
        apis.forEach(function (api, i) {
            if (!isSubscriptionEntry(api) || api.subscriptionId !== id) return;
            out.push({
                key: 'custom_' + i,
                name: api.name,
                url: api.url,
                isAdult: api.isAdult === true,
                selected: sel.has('custom_' + i),
            });
        });
        return out;
    }

    function getCachedStats(id) {
        const c = loadCache()[id];
        return c ? c.stats : null;
    }

    // ---------- 启动：缓存优先 + 后台刷新 ----------
    function scheduleAutoRefresh(cfg) {
        if (cfg.autoRefreshOnStartup === false) return;
        const ttlMs = Math.max(0, Number(cfg.refreshTtlMinutes) || 0) * 60000;
        const due = cfg.subscriptions.filter(function (s) {
            if (s.enabled === false) return false;
            if (ttlMs <= 0) return true;                       // 默认：每次打开都刷新
            return !s.lastSuccessAt || (Date.now() - s.lastSuccessAt) >= ttlMs;
        });
        if (!due.length) return;

        // 延后到首屏渲染之后，且不 await：绝不阻塞启动
        setTimeout(function () {
            (async function () {
                for (let i = 0; i < due.length; i++) {
                    try {
                        await refreshSubscription(due[i].id, { manual: false });
                    } catch (e) {
                        // 静默失败：保留缓存，仅留控制台线索
                        console.warn('[Veliora] 订阅自动刷新失败（保留上次成功数据）：', due[i].url, friendlyError(e));
                    }
                }
            })();
        }, 1000);
    }

    /**
     * 初始化：同步恢复缓存 → 渲染 → 后台刷新。整页生命周期只启动一次自动刷新。
     * 任何异常都被吞掉，保证订阅问题不会拖垮应用启动。
     */
    function init(options) {
        onChange = options && options.onChange;
        let restored = 0;
        try {
            const cfg = loadConfig();
            restored = reactivateFromCache(cfg);
            notify();
            if (!autoRefreshStarted) {
                autoRefreshStarted = true;
                scheduleAutoRefresh(cfg);
            }
        } catch (e) {
            console.warn('[Veliora] 订阅初始化失败（忽略，不影响使用）：', e && e.message);
        }
        return restored;
    }

    window.VelioraSubscriptions = {
        init: init,
        getSubscriptions: getSubscriptions,
        getSubscription: getSubscription,
        getSubscriptionSources: getSubscriptionSources,
        getCachedStats: getCachedStats,
        addSubscription: addSubscription,
        removeSubscription: removeSubscription,
        setEnabled: setEnabled,
        refreshSubscription: refreshSubscription,
        isRefreshing: isRefreshing,
        subId: subId,
        normalizeSubscriptionUrl: normalizeSubscriptionUrl,
        _applySubscriptionSources: applySubscriptionSources,   // 测试/调试用
    };
})();
