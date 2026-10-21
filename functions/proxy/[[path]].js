// functions/proxy/[[path]].js
//
// Cloudflare Pages Functions 入口：只负责解析请求、调用共享代理核心。
// 具体策略（超时/重试/熔断/头过滤/豆瓣 Referer）见 lib/proxy-core.mjs。

import { handleProxyRequest, decodeTargetUrl } from '../../lib/proxy-core.mjs';

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
};

const PROXY_PREFIX = '/proxy/';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return onRequestOptions();

    const encoded = url.pathname.startsWith(PROXY_PREFIX)
        ? url.pathname.slice(PROXY_PREFIX.length)
        : '';

    const result = await handleProxyRequest({
        targetUrl: decodeTargetUrl(encoded),
        auth: url.searchParams.get('auth'),
        timestamp: url.searchParams.get('t'),
        env,
        method: request.method,
    });

    return new Response(result.body, {
        status: result.status,
        headers: { ...CORS, ...result.headers },
    });
}

export function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: { ...CORS, 'access-control-max-age': '86400' },
    });
}
