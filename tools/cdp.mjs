#!/usr/bin/env node
/**
 * cdp.mjs — 与调试浏览器（127.0.0.1:9222）对话的最小工具。
 *
 * 关键约定：**永远新建自己的标签页**，不导航、不占用用户正在看的标签页。
 * （早前的实现直接抓第一个 page target，结果把用户正在浏览的页面当成被测页面。）
 *
 * 导出：
 *   loadWs()                      取 ws 模块（从 dsh 安装目录里找）
 *   withOwnTab(opts, fn)          建临时标签页 → 交给 fn(send) → 关闭标签页
 */

import { createRequire } from 'node:module';

export function loadWs() {
  const roots = [
    process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/node_modules/` : null,
    `C:/Users/${process.env.USERNAME ?? ''}/.dsh/profiles/node_modules/`,
    `${process.cwd()}/node_modules/`,
  ].filter(Boolean);
  for (const root of roots) {
    try { return createRequire(root)('ws'); } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 `ws` 模块：请在装了 dsh 的机器上运行（它自带 ws），或先 npm i ws');
}

export async function devtoolsList() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json().catch(() => null);
  if (!list) throw new Error('连不上 127.0.0.1:9222：先启动调试浏览器（browser-control skill 的 start_debug_browser.ps1）');
  return list;
}

/** 连接一个 CDP 端点，返回 send(method, params) 与 close()。 */
async function connect(WebSocket, url) {
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method) events.push(msg);
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { send, events, close: () => ws.close() };
}

/**
 * 新建一个临时标签页跑一批 CDP 操作，结束后关掉它。
 * @param {{url?:string,width?:number,height?:number,mobile?:boolean,touch?:boolean,waitMs?:number}} opts
 * @param {(send:Function, events:Array)=>Promise<any>} fn
 */
export async function withOwnTab(opts, fn) {
  const WebSocket = loadWs();
  const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const browser = await connect(WebSocket, version.webSocketDebuggerUrl);
  // background:true —— 后台标签页，不抢用户当前标签页的焦点
  const created = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
  const targetId = created.result?.targetId;
  if (!targetId) throw new Error('Target.createTarget 失败：' + JSON.stringify(created.error ?? created));
  try {
    // 新建的标签页不一定立刻出现在 /json/list 里，轮询等它一下
    let entry = null;
    for (let i = 0; i < 20 && !entry; i++) {
      const list = await devtoolsList();
      entry = list.find((t) => t.id === targetId) ?? null;
      if (!entry) await new Promise((r) => setTimeout(r, 100));
    }
    if (!entry) throw new Error('新建的标签页没出现在 /json/list 里（targetId=' + targetId + '）');
    if (process.env.FLOW_CDP_DEBUG) {
      process.stderr.write('cdp: target=' + targetId + ' url=' + entry.url + ' ws=' + entry.webSocketDebuggerUrl + '\n');
    }
    const page = await connect(WebSocket, entry.webSocketDebuggerUrl);
    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      if (opts.width && opts.height) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: opts.width, height: opts.height, deviceScaleFactor: 1,
          mobile: !!opts.mobile, screenWidth: opts.width, screenHeight: opts.height,
        });
      }
      if (opts.touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      if (opts.url) await page.send('Page.navigate', { url: opts.url });
      await new Promise((r) => setTimeout(r, opts.waitMs ?? 2500));
      if (process.env.FLOW_CDP_DEBUG) {
        const now = await evaluate(page.send, 'location.href');
        process.stderr.write('cdp: 导航后 location=' + now + '\n');
      }
      return await fn(page.send, page.events, targetId);
    } finally {
      page.close();
    }
  } finally {
    await browser.send('Target.closeTarget', { targetId });
    browser.close();
  }
}

/** 在页面里求值一段 JS，返回其值（字符串/对象皆可）。 */
export async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description ?? '页面内异常');
  }
  return res.result?.result?.value;
}
