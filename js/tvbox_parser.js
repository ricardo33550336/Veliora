/**
 * TVBOX 配置解析层（移植自 LibreTV src/lib/tvbox-parser.ts + source-list.ts）
 *
 * 纯函数，无网络、无 DOM。职责：
 *   TVBOX JSON / LibreTV-SourceList JSON  →  Veliora 可直接使用的 CMS 源数组
 *
 * 只导入「直连类」条目：
 *   - type=1（JSON 接口，即苹果 CMS 采集站）；type 缺失 / 写成 0 / 4 但地址命中
 *     Apple CMS 特征时同样宽容导入（与 LibreTV 行为一致）。
 *   - type=3 Spider（csp_* / jar / js / py）与本地相对资源需要 TVBOX 引擎，Veliora 无法
 *     运行：一律跳过并计入统计，绝不阻断其余条目。
 *
 * 归一化规则（与 LibreTV 一致，并补上 Veliora 特有的一步）：
 *   - 必须 http(s)，去掉尾部 `/`；
 *   - Veliora 搜索/详情会自行拼接 `?ac=videolist&wd=`，因此 TVBOX 里形如
 *     `.../api.php/provide/vod/?ac=list` 的探测参数必须剥掉，否则会拼成
 *     `...?ac=list?ac=videolist&wd=` 这种坏地址。
 */
(function () {
    'use strict';

    // 单次订阅最多导入的点播源数量（防止畸形配置把 localStorage 撑爆）
    const MAX_VOD_SOURCES = 500;

    // TVBOX 站点类型：0=XML 接口，1=JSON 接口，3=Spider，4=JSON 外链
    const SITE_TYPE_XML = 0;
    const SITE_TYPE_JSON = 1;
    const SITE_TYPE_SPIDER = 3;
    const SITE_TYPE_API = 4;

    // Spider 特征：csp_ 前缀，或 jar / js / py 资源（含查询串）
    const SPIDER_PATTERN = /^csp_|\.(?:jar|js|py)(?:[?#].*)?$/i;
    // 非 http(s) 的相对/本地资源（如 ./json/xxx.json）同样需要 TVBOX 引擎
    const LOCAL_ASSET_PATTERN = /^\.{0,2}\//;
    // Apple CMS 直连接口特征（排除 XML 通道 /at/xml）
    const CMS_API_PATTERN = /\/api\.php\/provide\/vod(?![^?#]*\/at\/xml)(?:[/?#]|$)/i;

    const SKIPPED_SAMPLE_LIMIT = 3;

    const SKIP_REASON_LABELS = {
        spider: 'Spider/Drpy 引擎',
        xml: 'XML 接口',
        unsearchable: '不支持搜索',
        nonM3uLive: '直播源（Veliora 不支持）',
        invalidUrl: '地址无效',
    };
    // 固定展示顺序，避免同类统计文案抖动
    const SKIP_REASON_ORDER = ['spider', 'xml', 'unsearchable', 'nonM3uLive', 'invalidUrl'];

    // ---------- 宽容 JSON 解析 ----------

    /**
     * 宽容 JSON 解析：部分共享配置带行注释、块注释或尾随逗号
     * （TVBOX 客户端用的 fastjson 默认容忍，标准 JSON.parse 会直接失败）。
     */
    function parseLenientJson(text) {
        const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
        try {
            return JSON.parse(stripJsonArtifacts(raw));
        } catch (e) {
            throw new Error('订阅内容不是合法的 JSON');
        }
    }

    function stripJsonArtifacts(text) {
        // 必须先剥注释再剥尾随逗号：`[1, // 注释\n]` 里的逗号隔着注释
        return stripTrailingCommas(stripComments(text));
    }

    function escapeControlChar(code) {
        if (code === 0x0a) return '\\n';
        if (code === 0x0d) return '\\r';
        if (code === 0x09) return '\\t';
        return '\\u' + code.toString(16).padStart(4, '0');
    }

    /** 剥离字符串外部的行注释与块注释，并把字符串里的裸控制字符转成合法转义 */
    function stripComments(text) {
        let out = '';
        let inString = false;
        let inLineComment = false;
        let inBlockComment = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = text[i + 1];

            if (inLineComment) {
                if (ch === '\n' || ch === '\r') { inLineComment = false; out += ch; }
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && next === '/') { inBlockComment = false; i += 1; }
                continue;
            }
            if (inString) {
                const code = ch.charCodeAt(0);
                if (code < 0x20) { out += escapeControlChar(code); continue; }
                out += ch;
                if (ch === '\\') { out += next == null ? '' : next; i += 1; }
                else if (ch === '"') { inString = false; }
                continue;
            }
            if (ch === '"') { inString = true; out += ch; continue; }
            if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue; }
            if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
            out += ch;
        }
        return out;
    }

    /** 剥离尾随逗号（`{"a":1,}` / `[1,2,]`），此时文本已不含注释 */
    function stripTrailingCommas(text) {
        let out = '';
        let inString = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                out += ch;
                if (ch === '\\') { out += text[i + 1] == null ? '' : text[i + 1]; i += 1; }
                else if (ch === '"') { inString = false; }
                continue;
            }
            if (ch === '"') { inString = true; out += ch; continue; }
            if (ch === ',') {
                let j = i + 1;
                while (j < text.length && /\s/.test(text[j])) j += 1;
                if (text[j] === '}' || text[j] === ']') continue;
            }
            out += ch;
        }
        return out;
    }

    // ---------- 判别 / 归一化 ----------

    /** TVBOX 配置判别：顶层出现 sites 数组即视为 TVBOX 配置 */
    function isTvboxPayload(json) {
        if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
        return Array.isArray(json.sites);
    }

    function optionalString(raw) {
        return (typeof raw === 'string' && raw.trim()) ? raw.trim() : undefined;
    }

    function toNumber(raw) {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
        return undefined;
    }

    function hostnameOf(url) {
        try { return new URL(url).hostname; } catch (e) { return url; }
    }

    /**
     * 归一化为 Veliora 可直接拼接参数的 CMS 基地址：
     * 校验 http(s) → 基于 URL 对象剥掉 query/hash → 去掉尾部 `/`。
     */
    function normalizeCmsApiUrl(raw) {
        const trimmed = optionalString(raw);
        if (!trimmed || !/^https?:\/\//i.test(trimmed)) return undefined;
        let u;
        try { u = new URL(trimmed); } catch (e) { return undefined; }
        let base = u.origin + u.pathname;
        base = base.replace(/\/+$/, '');
        return base || undefined;
    }

    // ---------- 解析入口 ----------

    /**
     * 自动识别格式并解析。
     * @returns {{format:string,name?:string,sources:Array,stats:Object}}
     */
    function parsePayload(json) {
        if (isTvboxPayload(json)) return parseTvboxPayload(json);
        return parseSourceListPayload(json);
    }

    /**
     * 解析 TVBOX 配置：sites → Veliora CMS 源，附带跳过与截断统计。
     * lives（直播）Veliora 无对应能力，全部计入跳过统计，用户能看清差异。
     */
    function parseTvboxPayload(json) {
        const record = (json && typeof json === 'object' && !Array.isArray(json)) ? json : {};
        const rawSites = Array.isArray(record.sites) ? record.sites : [];
        const rawLives = Array.isArray(record.lives) ? record.lives : [];
        const skipped = { count: 0, byReason: {}, samples: [] };

        const vod = collectVodSources(rawSites, skipped);
        rawLives.forEach(function (live) {
            markSkipped(skipped, 'nonM3uLive', live && live.name);
        });

        return {
            format: 'tvbox',
            name: optionalString(record.name),
            sources: vod.sources,
            stats: {
                format: 'tvbox',
                total: rawSites.length + rawLives.length,
                imported: vod.sources.length,
                skipped: skipped.count,
                skippedByReason: skipped.byReason,
                skippedSamples: skipped.samples.length ? skipped.samples : undefined,
                truncated: vod.truncated,
            },
        };
    }

    /** 解析 LibreTV-SourceList JSON（兼容裸数组 / {sources:[...]} 老格式） */
    function parseSourceListPayload(json) {
        const asArray = Array.isArray(json) ? json : null;
        const asObject = asArray ? null : (json && typeof json === 'object' ? json : null);
        const rawVod = asArray ? asArray : (asObject && Array.isArray(asObject.sources) ? asObject.sources : []);

        if (!rawVod.length) {
            throw new Error('订阅内容格式不正确（缺少 sites / sources 数组）');
        }

        const seen = new Set();
        const sources = [];
        let truncated = 0;
        for (let i = 0; i < rawVod.length; i++) {
            const item = rawVod[i];
            if (!item || typeof item !== 'object') continue;
            const url = normalizeCmsApiUrl(item.url);
            if (!url) continue;
            if (seen.has(url)) continue;
            if (sources.length >= MAX_VOD_SOURCES) { truncated += 1; continue; }
            seen.add(url);
            sources.push({
                name: optionalString(item.name) || hostnameOf(url),
                url: url,
                detail: optionalString(item.detail),
                isAdult: item.isAdult === true,
                originalKey: optionalString(item.key),
                originalType: 1,
            });
        }

        return {
            format: 'libretv',
            name: asObject ? optionalString(asObject.name) : undefined,
            sources: sources,
            stats: {
                format: 'libretv',
                total: rawVod.length,
                imported: sources.length,
                skipped: 0,
                skippedByReason: {},
                truncated: truncated,
            },
        };
    }

    /** 收集点播源：只接受 Apple CMS 直连接口；坏条目跳过不影响其余 */
    function collectVodSources(rawSites, skipped) {
        const seen = new Set();
        const sources = [];
        let truncated = 0;

        for (let i = 0; i < rawSites.length; i++) {
            const raw = rawSites[i];
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
            const name = optionalString(raw.name);
            const api = optionalString(raw.api);
            const type = toNumber(raw.type);

            if (!api) { markSkipped(skipped, 'invalidUrl', name); continue; }

            // Spider 类与本地资源需要 TVBOX 引擎，Veliora 侧无法运行
            if (type === SITE_TYPE_SPIDER || SPIDER_PATTERN.test(api)) {
                markSkipped(skipped, 'spider', name);
                continue;
            }
            if (!/^https?:\/\//i.test(api)) {
                markSkipped(skipped, LOCAL_ASSET_PATTERN.test(api) ? 'spider' : 'invalidUrl', name);
                continue;
            }
            // 站点自身声明不可搜索：Veliora 只有搜索入口，导入后无从使用
            if (raw.searchable === 0 || raw.searchable === '0') {
                markSkipped(skipped, 'unsearchable', name);
                continue;
            }

            // 可导入判定：显式 JSON 接口，或类型缺失/写成 XML、外链但地址命中 Apple CMS 特征
            const importable =
                type === SITE_TYPE_JSON ||
                ((type === undefined || type === SITE_TYPE_XML || type === SITE_TYPE_API) && CMS_API_PATTERN.test(api));
            if (!importable) {
                markSkipped(skipped, type === SITE_TYPE_API ? 'spider' : 'xml', name);
                continue;
            }

            const url = normalizeCmsApiUrl(api);
            if (!url) { markSkipped(skipped, 'invalidUrl', name); continue; }
            if (seen.has(url)) continue; // 重复 API：静默去重，与 LibreTV 订阅语义一致
            if (sources.length >= MAX_VOD_SOURCES) { truncated += 1; continue; }
            seen.add(url);
            sources.push({
                name: name || hostnameOf(url),
                url: url,
                isAdult: raw.isAdult === true,
                originalKey: optionalString(raw.key),
                originalType: type === undefined ? 1 : type,
            });
        }

        return { sources: sources, truncated: truncated };
    }

    function markSkipped(counter, reason, name) {
        counter.count += 1;
        counter.byReason[reason] = (counter.byReason[reason] || 0) + 1;
        if (name && counter.samples.length < SKIPPED_SAMPLE_LIMIT && counter.samples.indexOf(name) === -1) {
            counter.samples.push(name);
        }
    }

    /** 按固定顺序拼装原因明细，如「Spider/Drpy 引擎 1245、XML 接口 11」 */
    function describeReasons(byReason) {
        const map = byReason || {};
        return SKIP_REASON_ORDER
            .filter(function (r) { return (map[r] || 0) > 0; })
            .map(function (r) { return SKIP_REASON_LABELS[r] + ' ' + map[r]; })
            .join('、');
    }

    /**
     * 生成导入结果补充说明，供 toast / 列表展示。
     * 例：发现 1276 个源，导入 19 个可用源，跳过 1257 个（Spider/Drpy 引擎 1245、XML 接口 11、地址无效 1）
     */
    function describeStats(stats, options) {
        if (!stats) return '';
        const opts = options || {};
        const parts = [];
        if (typeof stats.total === 'number') parts.push('发现 ' + stats.total + ' 个源');
        if (typeof stats.imported === 'number') parts.push('导入 ' + stats.imported + ' 个可用源');
        if (stats.skipped > 0) {
            parts.push('跳过 ' + stats.skipped + ' 个（' + describeReasons(stats.skippedByReason) + '）');
        }
        if (stats.truncated > 0) parts.push('超出上限截断 ' + stats.truncated + ' 条');
        let text = parts.join('，');
        if (opts.includeSamples && stats.skippedSamples && stats.skippedSamples.length) {
            text += '，如「' + stats.skippedSamples.join('」「') + '」';
        }
        return text;
    }

    window.VelioraTVBox = {
        parseLenientJson: parseLenientJson,
        isTvboxPayload: isTvboxPayload,
        parsePayload: parsePayload,
        parseTvboxPayload: parseTvboxPayload,
        parseSourceListPayload: parseSourceListPayload,
        normalizeCmsApiUrl: normalizeCmsApiUrl,
        describeStats: describeStats,
        MAX_VOD_SOURCES: MAX_VOD_SOURCES,
    };
})();
