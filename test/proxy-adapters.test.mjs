import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handler as netlifyHandler } from '../netlify/functions/proxy.mjs';
import vercelHandler from '../api/proxy/[...path].mjs';
import { onRequest as cfOnRequest, onRequestOptions as cfOnOptions } from '../functions/proxy/[[path]].js';

let server;
let target;
let encoded;
let auth;
const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

before(async () => {
    auth = await sha256Hex('test');
    Object.assign(process.env, {
        PASSWORD: 'test',
        BLOCKED_HOSTS: '',
        BLOCKED_IP_PREFIXES: '',
        MAX_RETRIES: '0',
        REQUEST_TIMEOUT: '2000',
        REQUEST_TOTAL_TIMEOUT: '5000',
    });
    server = http.createServer((req, res) => {
        if (req.url === '/bin') {
            res.setHeader('content-type', 'image/png');
            res.end(binary);
        } else {
            res.statusCode = 404;
            res.end('not found');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    target = `http://127.0.0.1:${server.address().port}/bin`;
    encoded = encodeURIComponent(target);
});

after(() => {
    server.closeAllConnections?.();
    server.close();
});

test('Netlify 适配器按 base64 返回二进制', async () => {
    const result = await netlifyHandler({
        httpMethod: 'GET',
        path: `/proxy/${encoded}`,
        queryStringParameters: { auth, t: String(Date.now()) },
        headers: {},
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.isBase64Encoded, true);
    assert.deepEqual(Buffer.from(result.body, 'base64'), binary);
});

test('Netlify OPTIONS 返回 204', async () => {
    const result = await netlifyHandler({ httpMethod: 'OPTIONS', path: '/proxy/x' });
    assert.equal(result.statusCode, 204);
});

test('Vercel 适配器输出 Buffer', async () => {
    const headers = {};
    const res = {
        statusCode: 0,
        body: null,
        setHeader(k, v) { headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        send(b) { this.body = b; return this; },
        end() { return this; },
    };
    await vercelHandler({
        method: 'GET',
        url: `/proxy/${encoded}`,
        query: { '...path': [encoded], auth, t: String(Date.now()) },
        headers: {},
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, binary);
});

test('Cloudflare 适配器返回原始字节', async () => {
    const result = await cfOnRequest({
        request: new Request(`https://example.com/proxy/${encoded}?auth=${auth}&t=${Date.now()}`),
        env: process.env,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), binary);
});

test('Cloudflare OPTIONS 返回 204', async () => {
    const result = await cfOnOptions();
    assert.equal(result.status, 204);
});
