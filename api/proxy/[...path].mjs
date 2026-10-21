// api/proxy/[...path].mjs
//
// Vercel 入口：只负责解析请求、调用共享代理核心、输出 Buffer。
// 具体策略（超时/重试/熔断/头过滤/豆瓣 Referer）见 lib/proxy-core.mjs。

import { handleProxyRequest, decodeTargetUrl } from '../../lib/proxy-core.mjs';

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
};

function extractEncodedPath(req) {
    const pathData = req.query && req.query['...path'];
    if (Array.isArray(pathData)) return pathData.join('/');
    if (typeof pathData === 'string') return pathData;
    if (req.url) {
        try {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            if (pathname.startsWith('/proxy/')) return pathname.slice('/proxy/'.length);
            if (pathname.startsWith('/api/proxy/')) return pathname.slice('/api/proxy/'.length);
        } catch {}
    }
    return '';
}

export default async function handler(req, res) {
    for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);

    if (req.method === 'OPTIONS') {
        res.status(204).setHeader('access-control-max-age', '86400').end();
        return;
    }

    const result = await handleProxyRequest({
        targetUrl: decodeTargetUrl(extractEncodedPath(req)),
        auth: req.query && req.query.auth,
        timestamp: req.query && req.query.t,
        env: process.env,
        method: req.method || 'GET',
    });

    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    res.status(result.status);

    if (req.method === 'HEAD' || !result.body || result.body.byteLength === 0) {
        res.end();
    } else {
        res.send(Buffer.from(result.body));
    }
}
