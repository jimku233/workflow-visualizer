#!/usr/bin/env node
/**
 * probe.mjs — 在**自己的临时标签页**里打开一个页面并跑一段 JS，用来验证交互行为。
 * 不会碰用户正在浏览的标签页。
 *
 * 用法：
 *   node probe.mjs <url> <script.js> [--w 390] [--h 844] [--mobile] [--touch] [--wait 2500]
 *
 * 脚本文件里写一个表达式（例如 (function(){ ... return JSON.stringify(x); })()），
 * 它的返回值会打到 stdout 的 `PROBE=` 后面；页面里的 console 与未捕获异常会打到 stderr。
 */

import { readFileSync } from 'node:fs';
import { withOwnTab, evaluate } from './cdp.mjs';

const argv = process.argv.slice(2);
const rest = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['mobile', 'touch'].includes(k)) { flags[k] = true; continue; }
    flags[k] = argv[++i];
  } else rest.push(a);
}
const [url, scriptFile] = rest;
if (!url || !scriptFile) {
  process.stderr.write('用法：node probe.mjs <url> <script.js> [--w 390] [--h 844] [--mobile] [--touch] [--wait 2500]\n');
  process.exit(2);
}
const expression = readFileSync(scriptFile, 'utf8');

const value = await withOwnTab(
  {
    url,
    width: flags.w ? Number(flags.w) : undefined,
    height: flags.h ? Number(flags.h) : undefined,
    mobile: !!flags.mobile,
    touch: !!flags.touch,
    waitMs: flags.wait ? Number(flags.wait) : 2500,
  },
  async (send, events) => {
    const result = await evaluate(send, expression);
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        process.stderr.write('EXCEPTION: ' + d.text + ' | ' + (d.exception?.description ?? '').split('\n').slice(0, 2).join(' ⏎ ') + '\n');
      }
      if (e.method === 'Runtime.consoleAPICalled') {
        process.stderr.write('CONSOLE.' + e.params.type + ': ' + e.params.args.map((x) => x.value ?? x.description).join(' ') + '\n');
      }
    }
    return result;
  },
);

process.stdout.write('PROBE=' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
