'use strict';

/**
 * 终极验证：直接对「打包后的 exe」做端到端检查。
 *
 * 之前所有诊断都是跑源码（electron .）。这次改成启动
 * dist/win-unpacked/InkWell.exe，通过远程调试端口连上去，
 * 真实点击画布，确认编辑器可见、样式正确。
 * 这样才能证明"用户装的 exe 里问题真的修好了"。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node scripts/verify-exe.js
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'InkWell.exe');
const PORT = 9229;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

/** 极简 CDP 客户端。不引入 ws 依赖，用 crypto 自己实现 WebSocket 握手 + 帧。 */
const crypto = require('crypto');
const net = require('net');

/**
 * 最小可用 WebSocket 客户端（仅支持 CDP 需要的：文本帧、无分片、无扩展）。
 * 返回 { send(obj), on(event, fn), close() }。
 */
function connectWs(url) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
  const handlers = { open: [], message: [] };
  let buf = Buffer.alloc(0);
  let handshaken = false;

  sock.on('connect', () => {
    sock.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
      `Host: ${u.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    if (!handshaken) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString();
      buf = buf.slice(idx + 4);
      if (!/101/.test(head.split('\r\n')[0])) {
        throw new Error('WebSocket 握手失败: ' + head.split('\r\n')[0]);
      }
      handshaken = true;
      handlers.open.forEach((f) => f());
    }

    // 逐帧解析（服务端→客户端帧未加掩码）
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (masked) { maskKey = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) break;      // 帧还没收全
      let payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (masked) {
        payload = Buffer.from(payload.map((v, i) => v ^ maskKey[i % 4]));
      }
      if (opcode === 1) handlers.message.forEach((f) => f(payload.toString()));
    }
  });

  const encode = (str) => {
    const data = Buffer.from(str);
    const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const maskedData = Buffer.from(data.map((v, i) => v ^ mask[i % 4]));
    return Buffer.concat([header, mask, maskedData]);
  };

  return {
    send: (obj) => sock.write(encode(JSON.stringify(obj))),
    on: (ev, fn) => handlers[ev].push(fn),
    close: () => sock.end(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(EXE)) {
    console.log('找不到 exe:', EXE);
    process.exit(1);
  }
  console.log('exe:', EXE);

  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  console.log('已启动 exe，pid=', child.pid);

  // 等调试端口起来
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const body = await httpGet(`http://127.0.0.1:${PORT}/json/list`);
      const list = JSON.parse(body);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { targets = page; break; }
    } catch (_) { /* 还没起来 */ }
  }

  if (!targets) {
    console.log('!! 没能连上调试端口（可能端口被占或启动失败）');
    try { child.kill(); } catch (_) {}
    process.exit(1);
  }
  console.log('已连上页面:', targets.url);

  // 用自带的极简 WebSocket 客户端连 CDP，注入真实点击并读取编辑器状态
  const ws = connectWs(targets.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send({ id: mid, method, params });
    });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    }
  });

  await new Promise((r) => ws.on('open', r));

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(function(){ try { ${expr} } catch(e) { return {__err:e.message}; } })()`,
      returnByValue: true,
      awaitPromise: false,
    });
    return r.result && r.result.value;
  };

  await sleep(2000);

  const out = await evalJs(`
    const { setTool } = window.__inkwell || {};
    if (!setTool) return { __err: '__inkwell 不存在（可能 bundle 没加载）' };
    const c = document.getElementById('canvas');
    const cr = c.getBoundingClientRect();
    setTool('text');
    const mk = (t, x, y) => new PointerEvent(t, { bubbles:true, cancelable:true, composed:true,
      clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:1,
      pointerType:'mouse', isPrimary:true });
    c.dispatchEvent(mk('pointerdown', 300, 250));
    c.dispatchEvent(mk('pointerup', 300, 250));

    const ed = document.getElementById('textEditor');
    const ta = document.getElementById('textInput');
    const ecs = getComputedStyle(ed);
    const tcs = getComputedStyle(ta);
    const er = ed.getBoundingClientRect();
    const hit = document.elementFromPoint(er.left + er.width/2, er.top + er.height/2);
    return {
      hidden: ed.hidden, display: ecs.display, opacity: ecs.opacity,
      visibility: ecs.visibility,
      rect: [er.left, er.top, er.width, er.height].map(Math.round),
      viewport: [window.innerWidth, window.innerHeight],
      全在视口内: er.left>=0 && er.top>=0 && er.right<=window.innerWidth+1 && er.bottom<=window.innerHeight+1,
      中心命中: hit ? (hit.id||hit.tagName) : 'null',
      命中textarea: hit===ta,
      taBg: tcs.backgroundColor,
      taBorder: tcs.borderTopWidth+' '+tcs.borderTopColor,
      taShadow: tcs.boxShadow,
      active: document.activeElement && document.activeElement.id,
    };
  `);

  console.log('\n=== 打包 exe 内编辑器状态 ===');
  console.log(JSON.stringify(out, null, 2));

  const ok =
    out && out.hidden === false && out.display === 'block' &&
    out.opacity === '1' && out.visibility === 'visible' &&
    out.全在视口内 === true && out.命中textarea === true &&
    out.taBg === 'rgb(58, 66, 87)';

  console.log('\n结论:', ok ? '✓ exe 内编辑器打开且可见（底色已是 #3a4257）' : '✗ 有问题，见上方数据');

  try { ws.close(); } catch (_) {}
  try { child.kill(); } catch (_) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.log('ERR', e.message);
  process.exit(2);
});
