#!/usr/bin/env node
/**
 * devshot.mjs — 用 CDP 设备模拟给流程图页面拍「手机 / 电脑」两张图，并打印实测布局数据。
 *
 * 为什么需要它：只截当前窗口一张图，无法验证「自动选版」和移动端断点——
 * 窗口尺寸改不了，但 CDP 的 Emulation.setDeviceMetricsOverride 可以。
 *
 * 前置：调试浏览器已在 127.0.0.1:9222（browser-control skill 的 start_debug_browser.ps1）。
 * 用法：node devshot.mjs <file-url|http-url> [手机.png] [电脑.png] [手机宽 手机高 电脑宽 电脑高]
 *
 * 依赖 `ws`：从 dsh 安装目录里取（profile 的 node_modules 有）；找不到时会提示。
 */

import { writeFileSync } from 'node:fs';
import { withOwnTab, evaluate } from './cdp.mjs';

const [url, outPhone = 'shot-phone.png', outDesk = 'shot-desk.png', pw = '390', ph = '844', dw = '1440', dh = '820'] = process.argv.slice(2);
if (!url) {
  process.stderr.write('用法：node devshot.mjs <url> [手机.png] [电脑.png] [手机宽 手机高 电脑宽 电脑高]\n');
  process.exit(2);
}

async function shot(width, height, mobile, out, label) {
  const info = await withOwnTab(
    { url, width, height, mobile, touch: mobile, waitMs: 2600 },
    async (send, events) => {
      await evaluate(send, "document.getElementById('zoom-fit') && document.getElementById('zoom-fit').click()");
      await new Promise((r) => setTimeout(r, 450));
      const probe = await evaluate(send, `JSON.stringify({
        inner:[innerWidth,innerHeight],
        variant:document.getElementById('canvas').getAttribute('data-show'),
        canvas:Math.round(document.getElementById('canvas').getBoundingClientRect().height),
        aside:Math.round(document.querySelector('aside').getBoundingClientRect().height),
        footer:Math.round(document.querySelector('footer').getBoundingClientRect().height),
        panelOpen:document.body.classList.contains('panel-open'),
        zoom:document.getElementById('zoom-label').textContent,
        panelChars:(document.querySelector('#detail').innerText||'').length,
        errors:0
      })`);
      const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(out, Buffer.from(cap.result.data, 'base64'));
      const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
      return { probe, errs };
    },
  );
  process.stdout.write(`${label} ${out} ← ${info.probe} 异常=${info.errs}\n`);
}

await shot(Number(pw), Number(ph), true, outPhone, '手机');
await shot(Number(dw), Number(dh), false, outDesk, '电脑');

