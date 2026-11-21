#!/usr/bin/env node
/**
 * Guard the two-product confusion that cost a whole round of investigation.
 *
 * The controller and the agent both had "a DSH desktop app", but they were
 * different products from different vendors:
 *
 *   DSH Desktop 0.13.0        DataElement          (what the agent had)
 *   DeepSeek Harness 0.2.2    Hangzhou DeepSeek AI (what the controller has)
 *
 * Because the names and the version numbers both look comparable, "0.13.0 vs
 * 0.2.2" reads like version drift. It is not: they are unrelated applications
 * with independent version lines, and no amount of config alignment would have
 * fixed the mismatch.
 *
 * This test pins the identity fields we now rely on, so a future replacement
 * script cannot silently reinstall the wrong product.
 *
 * It checks the repo, not a live machine: the vendor, executable name, and
 * install path are all recorded in the replacement script, and the agent may be
 * offline (it is a laptop that travels).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const replaceScript = join(root, 'install', 'replace-dsh-desktop.ps1');

test('替换脚本存在', () => {
  assert.ok(existsSync(replaceScript), '缺少 install/replace-dsh-desktop.ps1');
});

const src = existsSync(replaceScript) ? readFileSync(replaceScript, 'utf8') : '';

test('目标产品是 DeepSeek Harness，不是 DSH Desktop', () => {
  // The download URL must point at deepseek-harness. A URL for dsh-desktop would
  // install the wrong vendor's app.
  assert.match(src, /download\.deepseek\.com\/dsh-desk\/bin\/win-x64\/deepseek-harness-/,
    '下载地址必须是官方 deepseek-harness 包');
  assert.doesNotMatch(src, /dsh-desktop-.*\.exe/,
    '不得下载 dsh-desktop 包');
});

test('签名主体校验到 DeepSeek', () => {
  // Hash matching a file we downloaded from the same place proves nothing about
  // who made it; the signer check is the real gate.
  assert.match(src, /Hangzhou DeepSeek/, '必须校验签名主体含 Hangzhou DeepSeek');
  assert.match(src, /sig\.Status -ne 'Valid'/, '必须拒绝无效签名');
});

test('先校验再卸载，顺序不能反', () => {
  const shaPos = src.indexOf('expectedSha512');
  const uninstallPos = src.indexOf('Uninstall DSH Desktop.exe');
  assert.ok(shaPos > 0, '缺少 SHA512 校验');
  assert.ok(uninstallPos > 0, '缺少卸载步骤');
  assert.ok(shaPos < uninstallPos,
    'SHA512 校验必须出现在卸载之前，否则删完才发现装不回来');
});

test('卸载旧产品的两个残留位置都要清理', () => {
  // The NSIS uninstaller leaves the directory behind often enough that removal
  // has to be checked explicitly; the registry entry is the other half.
  assert.match(src, /D:\\DSH Desktop/, '必须检查 D:\\DSH Desktop 目录');
  assert.match(src, /Remove-Item 'D:\\DSH Desktop'/, '必须能清理残留目录');
  assert.match(src, /DisplayName -match 'DSH Desktop'/, '必须回读注册表确认卸载干净');
});

test('安装后回读版本，不只信退出码', () => {
  // electron-builder NSIS returns 0 even when it wrote nothing in some cases,
  // so the installer exit code is not evidence of success.
  assert.match(src, /FileVersion/, '必须回读 FileVersion');
  assert.match(src, /ProductName/, '必须回读 ProductName');
  assert.match(src, /for \(\$i = 0; \$i -lt 30; \$i\+\+\)/,
    '必须轮询等待可执行文件出现，不能装完立刻假设文件已就位');
});

test('脚本是纯 ASCII 且无 BOM', () => {
  // PowerShell 5.1 reads BOM-less files as GBK; any non-ASCII byte causes a
  // syntax error at parse time (this has bitten the project three times).
  const bytes = readFileSync(replaceScript);
  const nonAscii = bytes.filter((b) => b > 127).length;
  assert.equal(nonAscii, 0, `脚本含 ${nonAscii} 个非 ASCII 字节`);
  assert.notDeepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], '不得带 UTF-8 BOM');
});
