// sshd 自愈脚本的测试。
//
// 分两层：
//   1. 离线检查 —— 纯 ASCII、PowerShell 语法、关键逻辑存在
//   2. 真机安装 —— 在设置了 FLEET_TEST_TARGET 时，真的把任务注册到
//      目标机器上再查一次。只做离线检查是不够的：计划任务的 XML 结构、
//      SYSTEM 主体权限这些只有真装一次才知道对不对。

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildHealScript,
  buildRegisterTaskScript,
  buildCheckTaskScript,
  TASK_NAME,
} from '../lib/selfheal.mjs';

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

const ascii = (s) => !/[^\x00-\x7F]/.test(s);

console.log('=== 生成 ===');

const heal = buildHealScript();
const register = buildRegisterTaskScript({ healScriptPath: 'C:\\ProgramData\\super-subagent\\heal.ps1' });
const check = buildCheckTaskScript();

ok('自愈脚本非空', heal.length > 2000, heal.length + ' 字符');
ok('自愈脚本纯 ASCII', ascii(heal));
ok('注册脚本纯 ASCII', ascii(register));
ok('检查脚本纯 ASCII', ascii(check));

console.log('');
console.log('=== 自愈逻辑的关键点 ===');

ok('会等待 tailscale 地址', heal.includes('tailscale.exe') && heal.includes('ip -4'));
ok('有等待上限（不会永久循环）', heal.includes('-le 60'));
ok('会检测地址过期', heal.includes('$stale'));
ok('保留了回环地址', heal.includes('ListenAddress 127.0.0.1'));
ok('不会绑 0.0.0.0', !heal.includes('ListenAddress 0.0.0.0'));
ok('改配置前先备份', heal.includes('.heal-bak'));
ok('重启前校验配置', heal.includes('-t -f $cfg'));
ok('校验失败会回滚', heal.includes('Copy-Item $bak $cfg -Force'));
ok('只在没跑时启动（不会打断正常服务）', heal.includes('Status -ne "Running"'));
ok('会验证真的在 tailnet 地址上监听', heal.includes('LocalAddress -eq $tsIp'));
ok('写日志到固定位置', heal.includes('sshd-heal.log'));

console.log('');
console.log('=== 注册逻辑的关键点 ===');

ok('任务名固定', register.includes(TASK_NAME));
ok('可重复执行（先删旧的）', register.includes('Unregister-ScheduledTask'));
ok('以 SYSTEM 运行（无人登录也能修）', register.includes('"SYSTEM"') && register.includes('ServiceAccount'));
ok('开机触发', register.includes('-AtStartup'));
ok('延迟 2 分钟（等 Tailscale 就绪）', register.includes('PT2M'));
ok('有重复尝试但有上限', register.includes('-RepetitionDuration') && register.includes('Hours 2'));
ok('有限执行时限', register.includes('ExecutionTimeLimit'));
ok('注册后立即跑一次', register.includes('Start-ScheduledTask'));
ok('注册后回读确认', register.includes('Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop'));
ok('缺脚本时明确报错', register.includes('heal script not found'));

console.log('');
console.log('=== PowerShell 语法检查（真解析）===');

const dir = mkdtempSync(join(tmpdir(), 'selfheal-'));
try {
  for (const [name, content] of [
    ['heal.ps1', heal],
    ['register.ps1', register],
    ['check.ps1', check],
  ]) {
    const f = join(dir, name);
    writeFileSync(f, content, 'utf8');
    let good = false;
    let detail = '';
    try {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}',[ref]$null,[ref]$e); if($e.Count -gt 0){ $e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }; exit 1 } else { 'OK' }`,
        ],
        { encoding: 'utf8', timeout: 60000 },
      );
      good = String(out).trim() === 'OK';
      detail = String(out).trim().slice(0, 300);
    } catch (e) {
      detail = String(e.stdout || e.message).slice(0, 300);
    }
    ok(name + ' 语法通过', good, detail);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('=== 真机安装（可选）===');

const target = process.env.FLEET_TEST_TARGET;
if (!target) {
  console.log('  跳过：未设置 FLEET_TEST_TARGET');
} else {
  // 用哪把私钥由 FLEET_TEST_KEY 决定，缺省仍是 laptop-a。
  // 真机上只有控制端那一把是被授权的（安装脚本只写 controller 的公钥），
  // 拿别的 key 去连必然 Permission denied —— 那是产品行为正确，不是缺陷。
  const key = process.env.FLEET_TEST_KEY
    ? process.env.FLEET_TEST_KEY
    : join(process.env.USERPROFILE || '', '.dsh-fleet', 'keys', 'laptop-a.key');
  const runRemote = (script) => {
    // 走 stdin 传脚本：ssh 的参数化引用在 Windows 上极难写对，
    // 之前已经因此失败过多次。
    const r = spawnSync(
      'ssh',
      [
        '-i', key,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=' + join(process.env.USERPROFILE || '', '.dsh-fleet', 'known_hosts'),
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=25',
        target,
        'powershell -NoProfile -NonInteractive -Command -',
      ],
      { input: script, encoding: 'utf8', timeout: 180000 },
    );
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  // 先看是否已注册
  const before = runRemote(buildCheckTaskScript());
  ok('能连上目标机器', before.code === 0, String(before.out).slice(0, 200));
  console.log('    安装前: ' + String(before.out).trim().split('\n').pop());

  // 把自愈脚本传上去（用 base64 避免任何换行/编码问题）
  const b64 = Buffer.from(heal, 'utf8').toString('base64');
  const upload = [
    '$ErrorActionPreference = "Stop"',
    '$dir = "C:\\ProgramData\\super-subagent"',
    'if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }',
    `$b64 = "${b64}"`,
    '$bytes = [Convert]::FromBase64String($b64)',
    '[IO.File]::WriteAllBytes("C:\\ProgramData\\super-subagent\\heal.ps1", $bytes)',
    'Write-Output ("written: " + (Get-Item "C:\\ProgramData\\super-subagent\\heal.ps1").Length + " bytes")',
  ].join('\n');

  const up = runRemote(upload);
  ok('自愈脚本已上传', up.code === 0 && /written: \d+ bytes/.test(up.out), String(up.out).slice(0, 200));
  console.log('    ' + String(up.out).trim().split('\n').pop());

  // 注册计划任务
  const reg = runRemote(register);
  ok('计划任务注册成功', reg.code === 0 && /registered:/.test(reg.out), String(reg.out).slice(0, 400));
  for (const line of String(reg.out).split('\n').filter((l) => l.trim())) {
    console.log('    ' + line.trim());
  }

  // 回读确认
  const after = runRemote(buildCheckTaskScript());
  ok('回读确认任务存在', /PRESENT/.test(after.out), String(after.out).slice(0, 200));
  console.log('    ' + String(after.out).trim().split('\n').pop());

  // 确认 sshd 仍然正常（自愈不能把好的弄坏）
  const sshAlive = runRemote('Write-Output (Get-Service sshd).Status');
  ok('sshd 仍然 Running（没被弄坏）', /Running/.test(sshAlive.out), String(sshAlive.out).slice(0, 200));
}

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
