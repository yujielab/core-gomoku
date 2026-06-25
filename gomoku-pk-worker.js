/* ============================================================================
 *  五子 · Gomoku —— 在线真人 PK 中继 (Cloudflare Worker，单文件)
 * ----------------------------------------------------------------------------
 *  能力：
 *   1) WebSocket 实时中继（房间号匹配，先到为蓝/先手，第二人执墨/后手）
 *   2) 服务端权威棋盘 + 五连判定（防作弊：占位/轮次/胜负均由服务端裁定）
 *   3) 内置 QR 编码器，/qr 直接吐 SVG（扫码加入用，无需任何外部库）
 *
 *  部署（wrangler）：
 *   wrangler.toml:
 *     name = "gomoku-pk"
 *     main = "gomoku-pk-worker.js"
 *     compatibility_date = "2024-09-01"
 *     [[durable_objects.bindings]]
 *       name = "ROOM"
 *       class_name = "Room"
 *     [[migrations]]
 *       tag = "v1"
 *       new_sqlite_classes = ["Room"]
 *   然后： wrangler deploy
 *
 *  客户端把本 Worker 的地址填进页面「在线对战 · 高级」即可（如
 *  https://gomoku-pk.<你的子域>.workers.dev）。
 *
 *  路由：
 *   GET /                状态页
 *   GET /health          → ok
 *   GET /qr?d=<文本>&s=<尺寸>   → image/svg+xml 二维码
 *   GET /new             → { room, ws, join } （可选，客户端也可自行生成房间号）
 *   GET /ws?room=CODE    → WebSocket 升级，加入房间 CODE
 *   GET /room/CODE/ws    → 同上（路径形式）
 * ========================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (p === '/' ) return html(landing());
    if (p === '/health') return text('ok');

    if (p === '/qr') {
      const d = url.searchParams.get('d') || url.searchParams.get('data') || '';
      const s = clampInt(url.searchParams.get('s'), 320, 96, 1400);
      let svg;
      try { svg = qrSvg(d, { size: s, margin: 4 }); }
      catch (e) { svg = errSvg(s, '二维码过长'); }
      return new Response(svg, {
        headers: { 'content-type': 'image/svg+xml;charset=utf-8', 'cache-control': 'public,max-age=86400', ...CORS },
      });
    }

    if (p === '/new') {
      const code = roomCode();
      return json({ room: code, ws: `/ws?room=${code}`, join: `?room=${code}` });
    }

    if (p === '/ws' || p.startsWith('/room/')) {
      let code = url.searchParams.get('room');
      if (!code && p.startsWith('/room/')) code = decodeURIComponent(p.split('/')[2] || '');
      code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      if (!code) return text('missing room code', 400);
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    return text('not found', 404);
  },
};

/* ============================ Durable Object：房间 ========================= */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = [];                 // [{ws, role, color, name}]
    this.board = new Map();            // "x,y" -> 'B' | 'W'
    this.moves = [];                   // [[x,y,color], ...]（有序，便于客户端重建）
    this.firstColor = 'B';             // 本局先手颜色（每次重开交替）
    this.turn = 'B';
    this.over = false;
    this.winner = null;
    this.line = null;                  // [[x1,y1],[x2,y2]] 五连端点
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const url = new URL(request.url);
    const code = (url.searchParams.get('room') || (url.pathname.split('/')[2] || '')).toUpperCase();
    const name = (url.searchParams.get('name') || '').slice(0, 24);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.accept(server, code, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  accept(ws, code, name) {
    ws.accept();
    const players = this.sockets.filter(s => s.role === 'player');
    let role = 'spectator', color = null;
    if (players.length < 2) { role = 'player'; color = players.length === 0 ? 'B' : 'W'; }
    const conn = { ws, role, color, name };
    this.sockets.push(conn);

    ws.addEventListener('message', ev => this.onMessage(conn, ev));
    ws.addEventListener('close', () => this.onClose(conn));
    ws.addEventListener('error', () => this.onClose(conn));

    this.send(ws, { t: 'welcome', you: role, color, code, turn: this.turn, first: this.firstColor });
    this.send(ws, this.stateMsg());
    this.broadcastPlayers();
  }

  onMessage(conn, ev) {
    let m; try { m = JSON.parse(ev.data); } catch { return; }

    if (m.t === 'ping') { this.send(conn.ws, { t: 'pong' }); return; }

    if (m.t === 'move') {
      if (conn.role !== 'player') return this.send(conn.ws, { t: 'reject', reason: 'spectator' });
      if (this.over)             return this.send(conn.ws, { t: 'reject', reason: 'over' });
      if (conn.color !== this.turn) return this.send(conn.ws, { t: 'reject', reason: 'turn' });
      const x = m.x | 0, y = m.y | 0, key = x + ',' + y;
      if (Math.abs(x) > 5000 || Math.abs(y) > 5000) return this.send(conn.ws, { t: 'reject', reason: 'range' });
      if (this.board.has(key))   return this.send(conn.ws, { t: 'reject', reason: 'occupied' });

      this.board.set(key, conn.color);
      this.moves.push([x, y, conn.color]);
      const line = this.winLine(x, y, conn.color);
      if (line) { this.over = true; this.winner = conn.color; this.line = line; }
      else this.turn = this.turn === 'B' ? 'W' : 'B';
      this.broadcast(this.stateMsg());
      return;
    }

    if (m.t === 'restart') {
      if (conn.role !== 'player') return;
      this.firstColor = this.firstColor === 'B' ? 'W' : 'B';   // 交替先手，公平
      this.board = new Map(); this.moves = [];
      this.over = false; this.winner = null; this.line = null;
      this.turn = this.firstColor;
      this.broadcast({ t: 'reset', turn: this.turn, first: this.firstColor });
      this.broadcast(this.stateMsg());
      return;
    }

    if (m.t === 'chat') {
      this.broadcast({ t: 'chat', name: conn.name || '对手', text: String(m.text || '').slice(0, 200) }, conn.ws);
    }
  }

  onClose(conn) {
    const i = this.sockets.indexOf(conn);
    if (i >= 0) this.sockets.splice(i, 1);
    // 玩家离开 → 通知对手并空出位置
    if (conn.role === 'player') this.broadcast({ t: 'left', color: conn.color });
    this.broadcastPlayers();
  }

  stateMsg() {
    return { t: 'state', moves: this.moves, turn: this.turn, over: this.over, winner: this.winner, line: this.line };
  }

  broadcastPlayers() {
    const players = this.sockets.filter(s => s.role === 'player');
    const msg = { t: 'players', count: players.length, colors: players.map(p => p.color) };
    this.broadcast(msg);
  }

  // 过 (x,y) 检查任一方向是否五连（freestyle：≥5 即胜）
  winLine(x, y, c) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of dirs) {
      let a = [x, y], b = [x, y], n = 1;
      for (let s = 1; s < 5; s++) { const k = (x + dx * s) + ',' + (y + dy * s); if (this.board.get(k) === c) { b = [x + dx * s, y + dy * s]; n++; } else break; }
      for (let s = 1; s < 5; s++) { const k = (x - dx * s) + ',' + (y - dy * s); if (this.board.get(k) === c) { a = [x - dx * s, y - dy * s]; n++; } else break; }
      if (n >= 5) return [a, b];
    }
    return null;
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const c of this.sockets) if (c.ws !== except) { try { c.ws.send(s); } catch {} }
  }
}

/* ============================ 小工具 / 响应 =============================== */
function text(s, status = 200) { return new Response(s, { status, headers: { 'content-type': 'text/plain;charset=utf-8', ...CORS } }); }
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json;charset=utf-8', ...CORS } }); }
function html(s) { return new Response(s, { headers: { 'content-type': 'text/html;charset=utf-8', ...CORS } }); }
function clampInt(v, def, lo, hi) { const n = parseInt(v || '', 10); if (!Number.isFinite(n)) return def; return Math.max(lo, Math.min(hi, n)); }

function roomCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉易混的 O0 I1 L
  let s = ''; for (let i = 0; i < 6; i++) s += A[(Math.random() * A.length) | 0];
  return s;
}

function landing() {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Gomoku PK relay</title>
<style>body{font:15px/1.6 -apple-system,system-ui,"PingFang SC",sans-serif;color:#1d1d1f;background:#f5f5f7;margin:0;display:grid;place-items:center;min-height:100vh}
.c{background:#fff;border-radius:20px;padding:28px 30px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:420px;margin:20px}
h1{font-size:20px;margin:0 0 6px}code{background:#f0f0f2;border-radius:6px;padding:1px 6px}a{color:#0071e3;text-decoration:none}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#34c759;margin-right:8px}</style>
<div class=c><h1><span class=dot></span>五子 · PK 中继在线</h1>
<p>这是 Gomoku 在线真人对战的信令/中继服务，由 Cloudflare Durable Object 驱动。</p>
<p>把本地址填入游戏页「在线对战 → 高级」即可联机：<br><code>${'wss://'}…/ws?room=房间号</code></p>
<p>扫码示例：<a href="/qr?d=hello&s=160">/qr?d=hello</a> · 健康检查：<a href="/health">/health</a></p></div>`;
}

function errSvg(size, msg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" fill="#fff"/><text x="50" y="52" font-size="7" text-anchor="middle" fill="#86868b" font-family="sans-serif">${msg}</text></svg>`;
}

/* ============================================================================
 *  QR 编码器（byte 模式，纠错等级 M，版本 1–10 自动选择）
 *  纯实现，无依赖；输出可被标准解码器识别的 SVG。
 * ========================================================================== */

// —— GF(256)，本原多项式 0x11d ——
const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(function () { let x = 1; for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]; })();
function gmul(a, b) { return (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }

// 生成多项式（次数 n，gen[0] 为首项系数 1）
function rsGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const np = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { np[j] ^= poly[j]; np[j + 1] ^= gmul(poly[j], GF_EXP[i]); }
    poly = np;
  }
  return poly;
}
function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.shift(); res.push(0);
    if (factor !== 0) for (let j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
  }
  return res;
}

// 纠错等级 M 的分块表： {ec: 每块纠错码字数, groups:[[块数, 每块数据码字], ...]}
const EC_M = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10:{ ec: 26, groups: [[4, 43], [1, 44]] },
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
function dataCapacity(v) { let n = 0; for (const [b, d] of EC_M[v].groups) n += b * d; return n; }

function utf8Bytes(str) {
  const out = []; for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i); const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return out;
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const cap = dataCapacity(v) * 8;
    const need = 4 + (v < 10 ? 8 : 16) + byteLen * 8;
    if (need <= cap) return v;
  }
  throw new Error('too long');
}

function encodeData(bytes, v) {
  const cap = dataCapacity(v) * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                       // byte 模式
  push(bytes.length, v < 10 ? 8 : 16);   // 字符计数
  for (const b of bytes) push(b, 8);
  for (let i = 0, t = Math.min(4, cap - bits.length); i < t; i++) bits.push(0); // 终止符
  while (bits.length % 8) bits.push(0);                                          // 字节对齐
  const pad = [0xEC, 0x11];
  for (let i = 0; bits.length < cap; i++) push(pad[i & 1], 8);                   // 填充字节
  const total = dataCapacity(v), out = new Array(total);
  for (let i = 0; i < total; i++) { let val = 0; for (let j = 0; j < 8; j++) val = (val << 1) | bits[i * 8 + j]; out[i] = val; }
  return out;
}

function interleave(dataCw, v) {
  const info = EC_M[v], blocks = []; let pos = 0;
  for (const [n, dpb] of info.groups) for (let i = 0; i < n; i++) {
    const d = dataCw.slice(pos, pos + dpb); pos += dpb;
    blocks.push({ d, ec: rsEncode(d, info.ec) });
  }
  const maxData = Math.max(...blocks.map(b => b.d.length)), res = [];
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.d.length) res.push(b.d[i]);
  for (let i = 0; i < info.ec; i++) for (const b of blocks) res.push(b.ec[i]);
  return res;
}

// —— 矩阵放置 ——
function newMatrix(size) { const m = []; for (let i = 0; i < size; i++) m.push(new Array(size).fill(null)); return m; }
function placeFinder(m, fn, r, c) {
  for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
    const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
    const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
    m[rr][cc] = on ? 1 : 0; fn[rr][cc] = true;
  }
}
function placeAlign(m, fn, r, c) {
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const on = Math.max(Math.abs(i), Math.abs(j)) !== 1; m[r + i][c + j] = on ? 1 : 0; fn[r + i][c + j] = true;
  }
}
function reserve(m, fn, r, c, val) { m[r][c] = val; fn[r][c] = true; }

function bchFormat(fmt) {
  let d = fmt << 10; const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= g << (i - 10);
  return ((fmt << 10) | d) ^ 0b101010000010010;
}
function bchVersion(v) {
  let d = v << 12; const g = 0b1111100100101;
  for (let i = 17; i >= 12; i--) if ((d >> i) & 1) d ^= g << (i - 12);
  return (v << 12) | d;
}

function maskFn(k, i, j) {
  switch (k) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
  }
  return false;
}

function penalty(m) {
  const n = m.length; let s = 0;
  // 规则1：行/列连续同色
  for (let i = 0; i < n; i++) for (const line of [m[i], m.map(r => r[i])]) {
    let run = 1; for (let j = 1; j < n; j++) { if (line[j] === line[j - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s += 1; } else run = 1; }
  }
  // 规则2：2x2 同色块
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) { const v = m[i][j]; if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) s += 3; }
  // 规则3：1011101 模式（含前后留白）
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) {
    const row = m[i], col = m.map(r => r[i]);
    let r1 = true, r2 = true, c1 = true, c2 = true;
    for (let t = 0; t < 11; t++) { if (row[j + t] !== pat1[t]) r1 = false; if (row[j + t] !== pat2[t]) r2 = false; if (col[j + t] !== pat1[t]) c1 = false; if (col[j + t] !== pat2[t]) c2 = false; }
    if (r1 || r2) s += 40; if (c1 || c2) s += 40;
  }
  // 规则4：暗块比例偏离 50%
  let dark = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (m[i][j]) dark++;
  const ratio = dark / (n * n) * 100; s += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return s;
}

function buildQR(text) {
  const bytes = utf8Bytes(text);
  const v = pickVersion(bytes.length);
  const size = 17 + 4 * v;
  const codewords = interleave(encodeData(bytes, v), v);

  const m = newMatrix(size), fn = newMatrix(size);
  // 定位图形 + 分隔
  placeFinder(m, fn, 0, 0); placeFinder(m, fn, 0, size - 7); placeFinder(m, fn, size - 7, 0);
  // 定时图形
  for (let i = 8; i < size - 8; i++) { const b = i % 2 === 0 ? 1 : 0; if (m[6][i] === null) { m[6][i] = b; fn[6][i] = true; } if (m[i][6] === null) { m[i][6] = b; fn[i][6] = true; } }
  // 校正图形
  const ac = ALIGN[v]; const last = ac[ac.length - 1];
  for (const r of ac) for (const c of ac) {
    if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
    placeAlign(m, fn, r, c);
  }
  // 暗模块
  reserve(m, fn, size - 8, 8, 1);
  // 预留格式信息区（占位 0，稍后填）
  for (let i = 0; i <= 8; i++) { if (i !== 6) { reserve(m, fn, 8, i, 0); reserve(m, fn, i, 8, 0); } }
  reserve(m, fn, 8, size - 8, 0);
  for (let i = 0; i < 8; i++) { if (size - 1 - i !== 6) reserve(m, fn, 8, size - 1 - i, 0); reserve(m, fn, size - 1 - i, 8, 0); }
  // 版本信息区（v≥7）
  if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { fn[i][size - 11 + j] = true; m[i][size - 11 + j] = 0; fn[size - 11 + j][i] = true; m[size - 11 + j][i] = 0; }

  // —— 放数据（之字形）——
  let dirUp = true, bit = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                       // 跳过定时列
    for (let t = 0; t < size; t++) {
      const row = dirUp ? size - 1 - t : t;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (fn[row][cc]) continue;
        let val = 0;
        if (bit < codewords.length * 8) { const byte = codewords[bit >> 3]; val = (byte >> (7 - (bit & 7))) & 1; bit++; }
        m[row][cc] = val;
      }
    }
    dirUp = !dirUp;
  }

  // —— 选最优掩码 ——
  let best = 0, bestScore = Infinity, bestM = null;
  for (let k = 0; k < 8; k++) {
    const mm = m.map(r => r.slice());
    for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) if (!fn[i][j] && maskFn(k, i, j)) mm[i][j] ^= 1;
    applyFormat(mm, size, k);
    if (v >= 7) applyVersion(mm, size, v);
    const sc = penalty(mm);
    if (sc < bestScore) { bestScore = sc; best = k; bestM = mm; }
  }
  return { matrix: bestM, size };
}

function applyFormat(m, size, mask) {
  const ecBits = 0b00;                         // 等级 M
  const fmt = bchFormat((ecBits << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const b = (fmt >> i) & 1;
    // 副本一（左上）
    if (i < 6) m[8][i] = b; else if (i === 6) m[8][7] = b;
    else if (i === 7) m[8][8] = b; else if (i === 8) m[7][8] = b;
    else m[14 - i][8] = b;
    // 副本二（右上 / 左下）
    if (i < 8) m[size - 1 - i][8] = b; else m[8][size - 15 + i] = b;
  }
  m[size - 8][8] = 1;                           // 暗模块
}
function applyVersion(m, size, v) {
  const vb = bchVersion(v);
  for (let i = 0; i < 18; i++) {
    const b = (vb >> i) & 1, r = Math.floor(i / 3), c = i % 3;
    m[r][size - 11 + c] = b; m[size - 11 + c][r] = b;
  }
}

function qrSvg(text, opts) {
  opts = opts || {}; const margin = opts.margin == null ? 4 : opts.margin; const size = opts.size || 320;
  const { matrix, size: n } = buildQR(text || '');
  const dim = n + margin * 2;
  let path = '';
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (matrix[i][j]) path += `M${j + margin} ${i + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="二维码">` +
         `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
         `<path d="${path}" fill="#0b0b0c"/></svg>`;
}
