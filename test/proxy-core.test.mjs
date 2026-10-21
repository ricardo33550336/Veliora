import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleProxyRequest } from '../lib/proxy-core.mjs';

let server;
let base;
let retryCount = 0;
const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const env = {
    PASSWORD: 'test',
    BLOCKED_HOSTS: '',
    BLOCKED_IP_PREFIXES: '',
    MAX_RETRIES: '2',
    REQUEST_TIMEOUT: '2000',
    REQUEST_TOTAL_TIMEOUT: '5000',
    BREAKER_THRESHOLD: '2',
    BREAKER_COOLDOWN: '60',
};

let auth;

before(async () => {
    auth = await sha256Hex('test');
    server = http.createServer((req, res) => {
        if (req.url === '/bin') {
            res.setHeader('content-type', 'image/png');
            res.end(binary);
        } else if (req.url === '/json') {
            res.setHeader('content-type', 'application/json');
            res.end('{"ok":true}');
        } else if (req.url === '/retry') {
            retryCount++;
            if (retryCount < 3) { res.statusCode = 503; res.end('busy'); }
            else res.end('ok');
        } else if (req.url === '/forbidden') {
            res.statusCode = 403;
            res.end('nope');
        } else if (req.url === '/hang') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('partial');   // 故意不 end：模拟发完头就挂住
        } else {
            res.statusCode = 404;
            res.end('not found');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.closeAllConnections?.();
    server.close();
});

test('二进制原样透传，content-encoding/length 由代理重算', async () => {
    const result = await handleProxyRequest({ targetUrl: `${base}/bin`, auth, env });
    assert.equal(result.status, 200);
    assert.deepEqual([...result.body], [...binary]);
    assert.equal(result.headers['content-type'], 'image/png');
    assert.equal(result.headers['content-length'], String(binary.length));
    assert.ok(!('content-encoding' in result.headers));
});

test('JSON 原样透传', async () => {
    const result = await handleProxyRequest({ targetUrl: `${base}/json`, auth, env });
    assert.equal(result.status, 200);
    assert.equal(new TextDecoder().decode(result.body), '{"ok":true}');
});

test('缺鉴权返回 401', async () => {
    const result = await handleProxyRequest({ targetUrl: `${base}/bin`, env });
    assert.equal(result.status, 401);
});

test('503 退避重试后成功', async () => {
    retryCount = 0;
    const result = await handleProxyRequest({ targetUrl: `${base}/retry`, auth, env });
    assert.equal(result.status, 200);
    assert.equal(new TextDecoder().decode(result.body), 'ok');
    assert.equal(retryCount, 3);
});

test('读响应体超时返回 504，不会一直挂住', async () => {
    const started = Date.now();
    const result = await handleProxyRequest({
        targetUrl: `${base}/hang`, auth,
        env: { ...env, REQUEST_TIMEOUT: '400', REQUEST_TOTAL_TIMEOUT: '2000', MAX_RETRIES: '1' },
    });
    assert.equal(result.status, 504);
    assert.ok(Date.now() - started < 1800);
});

test('默认拦截本机/内网地址', async () => {
    const result = await handleProxyRequest({
        targetUrl: `${base}/bin`, auth,
        env: { PASSWORD: 'test', BLOCKED_HOSTS: 'localhost,127.0.0.1,0.0.0.0,::1' },
    });
    assert.equal(result.status, 400);
});

test('豆瓣图床带专用 Referer', async () => {
    const realFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (_url, opts) => {
        captured = opts.headers;
        return new Response('fake', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    try {
        const result = await handleProxyRequest({
            targetUrl: 'https://img1.doubanio.com/view/photo/x.jpg', auth, env,
        });
        assert.equal(result.status, 200);
        assert.equal(captured.referer, 'https://movie.douban.com/');
        assert.match(captured['user-agent'], /Mozilla/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

// 放最后：熔断会按 host 生效，避免影响前面的同 host 用例
test('403 连续失败后 host 熔断返回 503', async () => {
    const first = await handleProxyRequest({ targetUrl: `${base}/forbidden`, auth, env });
    assert.equal(first.status, 403);
    const second = await handleProxyRequest({ targetUrl: `${base}/forbidden`, auth, env });
    assert.equal(second.status, 403);
    const third = await handleProxyRequest({ targetUrl: `${base}/forbidden`, auth, env });
    assert.equal(third.status, 503);
    assert.ok(third.headers['retry-after']);
});
