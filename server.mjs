import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // 单次上游请求超时。不能太短：4~8s 才回应的采集源很常见，
  // 收得太紧会把还能用的源判成坏源（之前“只剩一个播放源”就是这么来的）。
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '8000'),
  // 单次代理请求的总时间预算：所有重试加起来不能超过它，
  // 否则前端早放弃了、后端还在为它重试，纯属浪费 socket（雪崩主因之一）
  totalTimeout: parseInt(process.env.REQUEST_TOTAL_TIMEOUT || '10000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  // 同时发往上游的最大请求数：防止一次搜索扇出上百个 socket 把本机/路由器打爆
  maxUpstream: parseInt(process.env.MAX_UPSTREAM_CONCURRENCY || '16'),
  // 同一 host 连续失败多少次后熔断，以及熔断冷却时长（秒）
  breakerThreshold: parseInt(process.env.BREAKER_THRESHOLD || '4'),
  breakerCooldown: parseInt(process.env.BREAKER_COOLDOWN || '60') * 1000,
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

// 只有网络层面的瞬时故障才值得重试。
// 证书过期 / 4xx（403 防盗链、404）都是永久性错误，重试只会白发请求、拖长等待。
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'
]);
const FATAL_CODES = new Set([
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);

function isRetryableError(error) {
  if (!error) return false;
  if (error.response) {
    const status = error.response.status;
    return status === 429 || status >= 500;   // 4xx 一律不重试
  }
  if (FATAL_CODES.has(error.code)) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  // 兜底：axios 的 socket hang up 没有 code，只能看消息
  return /socket hang up|ECONNRESET|network|timeout/i.test(error.message || '');
}

// 复用 TCP/TLS 连接：否则每个上游请求都要重新握手，电视端/弱网下开销很大
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, timeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, timeout: 30000 });

// 上游并发信号量：超出的请求排队，避免瞬间开几十条连接
let activeUpstream = 0;
const upstreamQueue = [];
function acquireUpstream() {
  if (activeUpstream < config.maxUpstream) {
    activeUpstream++;
    return Promise.resolve();
  }
  return new Promise(resolve => upstreamQueue.push(resolve));
}
function releaseUpstream() {
  const next = upstreamQueue.shift();
  if (next) next();            // 名额直接转交，activeUpstream 不变
  else activeUpstream--;
}

// 按 host 的熔断器：证书过期/403 这类“死源”连续失败后直接短路，
// 不再让每次搜索都为它等一遍超时。冷却结束后只放一个探测请求（半开）。
const breakers = new Map();   // host -> { fails, openUntil, probing }

function breakerAllow(host) {
  const b = breakers.get(host);
  if (!b) return true;
  if (b.openUntil && Date.now() < b.openUntil) return false;   // 熔断中
  if (b.openUntil) {                                           // 冷却结束：半开，只放一个探测
    if (b.probing) return false;
    b.probing = true;
  }
  return true;
}

function breakerDone(host, ok) {
  const b = breakers.get(host);
  if (ok) {
    if (b) breakers.delete(host);
    return;
  }
  const cur = b || { fails: 0, openUntil: 0, probing: false };
  cur.fails += 1;
  cur.probing = false;
  if (cur.fails >= config.breakerThreshold) {
    cur.openUntil = Date.now() + config.breakerCooldown;
    cur.fails = 0;
    log(`熔断 host ${host}，冷却 ${config.breakerCooldown / 1000}s`);
  }
  breakers.set(host, cur);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// 哪些错误算“上游真的坏了”，才值得熔断：证书过期、DNS 找不到、拒绝连接、401/403。
// 超时/连接重置/5xx 都是瞬时或“只是慢”，不算 —— 否则会把慢源误封，
// 用户就会看到“播放源只剩一个”。404/400 是路径问题，同样不算。
const HARD_HOST_FAILURES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);
function breakerFailureWorthy(error) {
  if (!error) return false;
  const status = error.response && error.response.status;
  if (status) return status === 401 || status === 403;
  return HARD_HOST_FAILURES.has(error.code);
}

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  } else {
    content = content.replace('{{PASSWORD}}', '');
  }
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// 验证代理请求的鉴权
function validateProxyAuth(req) {
  const authHash = req.query.auth;
  const timestamp = req.query.t;
  
  // 获取服务器端密码哈希
  const serverPassword = config.password;
  if (!serverPassword) {
    console.error('服务器未设置 PASSWORD 环境变量，代理访问被拒绝');
    return false;
  }
  
  // 使用 crypto 模块计算 SHA-256 哈希
  const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
  
  if (!authHash || authHash !== serverPasswordHash) {
    console.warn('代理请求鉴权失败：密码哈希不匹配');
    console.warn(`期望: ${serverPasswordHash}, 收到: ${authHash}`);
    return false;
  }
  
  // 验证时间戳（10分钟有效期）
  if (timestamp) {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分钟
    if (now - parseInt(timestamp) > maxAge) {
      console.warn('代理请求鉴权失败：时间戳过期');
      return false;
    }
  }
  
  return true;
}

app.get('/proxy/:encodedUrl', async (req, res) => {
  // 客户端（浏览器/电视端）一旦断开，立刻中止上游请求，
  // 否则它会在后端继续跑完所有重试，白占连接和 socket。
  const abortController = new AbortController();
  // 用 res 的 close：只有响应没真正发完（客户端提前断开）才中止；
  // 正常结束后 writableFinished 为 true，不会误伤刚拿到的上游响应
  res.on('close', () => {
    if (!res.writableFinished) abortController.abort();
  });
  // 提到 try 外面：catch 里打日志要用，块作用域里的 const 在外面看不到
  let targetUrl = null;

  try {
    // 验证鉴权
    if (!validateProxyAuth(req)) {
      return res.status(401).json({
        success: false,
        error: '代理访问未授权：请检查密码配置或鉴权参数'
      });
    }

    const encodedUrl = req.params.encodedUrl;
    targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // host 熔断：证书过期/403 的“死源”直接短路，不再每次都等一个超时
    const host = hostOf(targetUrl);
    if (host && !breakerAllow(host)) {
      return res.status(503)
        .set('Retry-After', String(Math.ceil(config.breakerCooldown / 1000)))
        .json({ success: false, error: `上游 ${host} 近期连续失败，已临时熔断` });
    }

    // 添加请求超时和重试逻辑（带总预算 + 指数退避 + 错误分类）
    const maxRetries = config.maxRetries;
    const deadline = Date.now() + config.totalTimeout;
    let retries = 0;

    const makeRequest = async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const err = new Error(`代理请求超时（总预算 ${config.totalTimeout}ms）: ${targetUrl}`);
        err.code = 'ETIMEDOUT_TOTAL';
        throw err;
      }
      try {
        // 豆瓣图片 CDN 有防盗链，需带对应 Referer，否则返回 418
        const reqHeaders = { 'User-Agent': config.userAgent };
        if (/doubanio\.com/.test(targetUrl)) {
          reqHeaders['Referer'] = 'https://movie.douban.com/';
        }
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: Math.min(config.timeout, remaining),
          signal: abortController.signal,
          headers: reqHeaders,
          httpAgent,
          httpsAgent
        });
      } catch (error) {
        // 客户端已断开：不再重试，直接退出
        if (abortController.signal.aborted) throw error;
        // 只重试瞬时故障，且退避后仍要留在总预算内
        if (retries < maxRetries && isRetryableError(error)) {
          retries++;
          const delay = Math.min(150 * Math.pow(2, retries - 1), 800) + Math.floor(Math.random() * 100);
          if (Date.now() + delay >= deadline) throw error;
          log(`重试请求 (${retries}/${maxRetries}, ${delay}ms 后) [${error.code || error.message}]: ${targetUrl}`);
          await new Promise(r => setTimeout(r, delay));
          return makeRequest();
        }
        throw error;
      }
    };

    // 上游并发限流：排到名额才发请求
    await acquireUpstream();
    let response;
    try {
      response = await makeRequest();
      if (host) breakerDone(host, true);
    } catch (error) {
      if (abortController.signal.aborted) {
        // 客户端主动断开：不算上游故障，但要把半开探测标记放回去，否则该 host 会被永久挡住
        const b = host && breakers.get(host);
        if (b) b.probing = false;
      } else if (host && breakerFailureWorthy(error)) {
        breakerDone(host, false);
      }
      throw error;
    } finally {
      releaseUpstream();
    }

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS || 
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');
    
    sensitiveHeaders.forEach(header => delete headers[header]);
    // axios 已把 gzip 响应解压，若把上游的 content-encoding/content-length 原样转发，
    // 浏览器按压缩后的长度收流会报 ERR_CONTENT_LENGTH_MISMATCH，采集源搜索就会随机失败。
    // 传输层头一律由本进程重新决定（与 android ProxyHandler.kt 的 FILTERED_HEADERS 一致）
    ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
      .forEach(header => delete headers[header]);
    res.set(headers);

    // 管道传输响应流
    response.data.pipe(res);
  } catch (error) {
    const code = error.code || (error.response && error.response.status) || '';
    console.error(`代理请求错误: ${error.message} | 目标: ${targetUrl || '解析失败'} | code: ${code}`);

    // 客户端已经走了：没有可写的响应，直接结束，避免 "headers already sent" 之类噪音
    if (req.destroyed || res.writableEnded) {
      if (!res.writableEnded) { try { res.end(); } catch {} }
      return;
    }

    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      // 499 客户端主动中止；504 代理侧超时；其余归为上游不可用 502
      const status = abortController.signal.aborted ? 499
        : (error.code === 'ETIMEDOUT_TOTAL' || error.code === 'ECONNABORTED' ? 504 : 502);
      res.status(status).send(`请求失败: ${error.message}`);
    }
  }
});

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('用户登录密码已设置');
  } else {
    console.log('警告: 未设置 PASSWORD 环境变量，用户将被要求设置密码');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});
