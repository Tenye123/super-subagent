// 重启 DSH 之后用来确认插件真的加载了。
//
// 为什么要单独一个脚本：插件加载失败的表现非常隐蔽——设置页里就是没有
// 那一项，没有报错弹窗，控制台也不一定有明显信息。所以只能从外部证：
// 端口有没有起来、API 有没有应答、扫描能不能出结果。
//
// 用法：node test/verify-loaded.mjs

const API = 'http://127.0.0.1:6210';
const BEACON_PORT = 47321;

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    console.log('  ✓ ' + label);
    pass++;
  } else {
    console.log('  ✗ ' + label + (extra ? '  -> ' + extra : ''));
    fail++;
  }
};

console.log('=== 1. 本地 API（面向前端）===');

let status = null;
try {
  const r = await fetch(API + '/status', { signal: AbortSignal.timeout(8000) });
  status = await r.json();
  ok('GET /status 返回 200', r.status === 200, 'status=' + r.status);
} catch (e) {
  ok('GET /status 可访问', false, String(e.message).slice(0, 160));
  console.log('');
  console.log('插件没有加载。检查顺序：');
  console.log('  1) profile 的 dependencies 有没有 dsh-super-subagent');
  console.log('  2) profile 的 dsh.profile.bundles 里有没有它');
  console.log('  3) 重启后 DSH 的日志里搜 super-subagent');
  console.log('');
  console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(1);
}

if (status) {
  ok('status 里有 self', Boolean(status.self), JSON.stringify(status.self));
  ok('本机有 tailnet 地址', Boolean(status.self && status.self.tailscaleIp), String(status.self && status.self.tailscaleIp));
  console.log('    角色: ' + (status.role || '?'));
  console.log('    本机: ' + (status.self ? status.self.tailscaleIp : '?'));
  console.log('    设备: ' + (Array.isArray(status.devices) ? status.devices.length : '?') + ' 台');
}

console.log('');
console.log('=== 2. 报名/下发端口（tailnet 面）===');

const selfIp = status.self && status.self.tailscaleIp;
if (selfIp) {
  try {
    const r = await fetch(`http://${selfIp}:${BEACON_PORT}/setup.ps1?id=definitely-not-valid`, {
      signal: AbortSignal.timeout(8000),
    });
    // 404 就是对的：端口在监听，只是这个 id 不存在。
    ok('tailnet 端口在监听（无效 id 返回 404）', r.status === 404, 'status=' + r.status);
  } catch (e) {
    ok('tailnet 端口在监听', false, String(e.message).slice(0, 160));
  }
}

console.log('');
console.log('=== 3. 一条命令真的能生成 ===');

let boot = null;
try {
  const r = await fetch(API + '/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentName: 'after-restart-check' }),
    signal: AbortSignal.timeout(20000),
  });
  boot = await r.json();
  ok('POST /bootstrap 成功', boot.ok === true, JSON.stringify(boot).slice(0, 160));
  ok('返回了 genId', Boolean(boot.genId), String(boot.genId));
} catch (e) {
  ok('POST /bootstrap 成功', false, String(e.message).slice(0, 160));
}

if (boot && boot.genId && selfIp) {
  try {
    const r = await fetch(`http://${selfIp}:${BEACON_PORT}/setup.ps1?id=${encodeURIComponent(boot.genId)}`, {
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    ok('用返回的 genId 能下载到脚本', r.status === 200 && txt.length > 5000, `status=${r.status} len=${txt.length}`);
    ok('下载的脚本是纯 ASCII', !/[^\x00-\x7F]/.test(txt));
    ok('脚本含自愈步骤', txt.includes('sshd-heal.ps1'));
  } catch (e) {
    ok('用返回的 genId 能下载到脚本', false, String(e.message).slice(0, 160));
  }
}

console.log('');
console.log('=== 4. 扫描能出结果 ===');

try {
  const r = await fetch(API + '/scan', { signal: AbortSignal.timeout(90000) });
  const scan = await r.json();
  ok('GET /scan 成功', r.status === 200, 'status=' + r.status);
  const list = scan.devices || scan.results || [];
  ok('扫描返回了设备列表', Array.isArray(list), typeof list);
  const ready = list.filter((d) => d.state === 'ready');
  console.log('    可见 ' + list.length + ' 台，可派活 ' + ready.length + ' 台');
  for (const d of list.slice(0, 6)) {
    console.log('      ' + (d.name || '?') + '  ' + (d.tailscaleIp || d.ip || '?') + '  [' + (d.state || '?') + ']');
  }
} catch (e) {
  ok('GET /scan 成功', false, String(e.message).slice(0, 160));
}

console.log('');
console.log('=== 结论 ===');
if (fail === 0) {
  console.log('  插件已加载并可用。设置页里应该有「超级子代理」。');
} else {
  console.log('  插件部分功能异常，看上面标 ✗ 的项。');
}
console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
