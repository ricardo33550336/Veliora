// netlify/functions/proxy.mjs
//
// Netlify 入口：只负责解析事件、调用共享代理核心、把二进制响应按 base64 返回。
// 具体策略（超时/重试/熔断/头过滤/豆瓣 Referer）见 lib/proxy-core.mjs。

import { handleProxyRequest, decodeTargetUrl } from '../../lib/proxy-core.mjs';

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
};

const PROXY_PREFIX = '/proxy/';
const FUNCTION_PREFIX = '/.netlify/functions/proxy/';

function extractEncodedPath(event) {
    const paths = [event.path || ''];
    if (event.rawUrl) {
        try { paths.push(new URL(event.rawUrl).pathname); } catch {}
    }
    for (const p of paths) {
        if (p.startsWith(PROXY_PREFIX)) return p.slice(PROXY_PREFIX.length);
        if (p.startsWith(FUNCTION_PREFIX)) return p.slice(FUNCTION_PREFIX.length);
    }
    return '';
}

export const handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: { ...CORS, 'access-control-max-age': '86400' },
            body: '',
        };
    }

    const params = event.queryStringParameters || {};
    const targetUrl = decodeTargetUrl(extractEncodedPath(event));
    const result = await handleProxyRequest({
        targetUrl,
        auth: params.auth,
        timestamp: params.t,
        env: process.env,
        method: event.httpMethod || 'GET',
    });

    return {
        statusCode: result.status,
        headers: { ...CORS, ...result.headers },
        body: Buffer.from(result.body).toString('base64'),
        isBase64Encoded: true,
    };
};
