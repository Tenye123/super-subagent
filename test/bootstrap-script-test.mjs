// 验证引导脚本生成器。
//
// 这里检查的不是"字符串里有某段字"，而是三件真会出事的事：
//   1. 生成的脚本必须是纯 ASCII —— PowerShell 5.1 按 GBK 读无 BOM 文件，
//      一个多字节字符能让下一行代码静默失效（实测过）。
//   2. 生成的脚本必须能被 PowerShell 解析器接受 —— 语法错会在目标机器上
//      表现为"跑到某一步就停了"，而用户完全不知道为什么。
//   3. 安全约束必须真的写进去了 —— 这些是防止把公司内网暴露出去的东西，
//      不能只靠注释声称。

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAgentScript, assertAscii } from '../lib/bootstrap-script.mjs';
import { createToken } from '../lib/beacon.mjs';

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

const PUB =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTestingOnly dsh-fleet';

const gen = (over = {}) =>
  buildAgentScript({
    controllerIp: '100.71.88.73',
    beaconPort: 47321,
    token: createToken(),
    controllerPubKey: PUB,
    agentName: 'laptop-b',
    sshPort: 22,
    ...over,
  });

console.log('=== 参数校验：坏输入必须被拒绝 ===');

const rejects = [
  ['IP 不合法', { controllerIp: 'not-an-ip' }],
  ['IP 越界', { controllerIp: '999.1.1.1' }],
  ['端口为 0', { beaconPort: 0 }],
  ['端口过大', { beaconPort: 70000 }],
  ['令牌格式错', { token: 'short' }],
  ['令牌无前缀', { token: 'A'.repeat(40) }],
  ['公钥格式错', { controllerPubKey: 'not-a-key' }],
  ['SSH 端口错', { sshPort: 0 }],
];

for (const [label, over] of rejects) {
  let threw = false;
  try {
    gen(over);
  } catch {
    threw = true;
  }
  ok(label + ' 被拒绝', threw);
}

console.log('');
console.log('=== 生成内容 ===');

const script = gen();
ok('生成成功', typeof script === 'string' && script.length > 3000, script.length + ' 字符');

const ascii = assertAscii(script);
ok('纯 ASCII', ascii.ok, ascii.ok ? '' : '第 ' + ascii.badIndex + ' 字符: ' + ascii.char);

ok('含控制器地址', script.includes("$ControllerIp   = '100.71.88.73'"));
ok('含报名端口', script.includes('$BeaconPort     = 47321'));
ok('含公钥', script.includes(PUB.slice(0, 40)));
ok('六个步骤齐全', [1, 2, 3, 4, 5, 6].every((n) => script.includes(`STEP ${n}/6`)));

console.log('');
console.log('=== 安全约束（这些不能只写在注释里）===');

ok(
  'sshd 绑定到 tailnet 而不是 0.0.0.0',
  script.includes('ListenAddress $tsIp') && !script.includes('ListenAddress 0.0.0.0'),
);
ok('保留回环地址', script.includes('ListenAddress 127.0.0.1'));
ok('禁用密码登录', script.includes('PasswordAuthentication no'));
ok('防火墙限定 100.64.0.0/10', script.includes('100.64.0.0/10'));
ok('公钥写进 administrators_authorized_keys', script.includes('administrators_authorized_keys'));
ok('密钥文件权限收紧', script.includes('icacls'));
ok('sshd 依赖 Tailscale（启动顺序）', script.includes('depend=,') || script.includes('"depend="'));
ok(
  '重试策略不是秒级死循环',
  script.includes('restart/60000/restart/60000/restart/60000'),
);
ok(
  '重启前先校验配置',
  script.indexOf('"-t", "-f", $cfg') > 0 && script.indexOf('"-t", "-f", $cfg') < script.indexOf('Restart-Service sshd'),
);
ok('校验失败会回滚', script.includes('Copy-Item $bak $cfg -Force'));

// 自愈：这是针对"开机时 sshd 绑不上 Tailscale 地址然后退出"那个故障的修复。
// 不加这一步，装好的机器下次重启就可能再也连不上。
ok('内嵌了自愈脚本', script.includes('sshd-heal.ps1'));
ok('注册了自愈计划任务', script.includes('register-heal-task.ps1'));
ok('自愈脚本以 base64 传输（避免引号/换行问题）', /\$healBody = '[A-Za-z0-9+/=]{500,}'/.test(script));
ok(
  '自愈失败不中断主流程',
  script.includes('warning: could not register the self-healing task'),
);

console.log('');
console.log('=== PowerShell 语法检查（真解析，不看字符串）===');

const dir = mkdtempSync(join(tmpdir(), 'subagent-gen-'));
const file = join(dir, 'setup-agent.ps1');
try {
  writeFileSync(file, script, 'utf8');
  let syntaxOk = false;
  let detail = '';
  try {
    // 用 PowerShell 自己的解析器，忽略执行策略，只解析不执行。
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$null,[ref]$e); if($e.Count -gt 0){ $e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }; exit 1 } else { 'OK' }`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    syntaxOk = String(out).trim() === 'OK';
    detail = String(out).trim().slice(0, 300);
  } catch (e) {
    detail = String(e.stdout || e.message || e).slice(0, 400);
  }
  ok('PowerShell 解析器接受生成的脚本', syntaxOk, syntaxOk ? '' : detail);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('=== 可选参数 ===');

const withKey = gen({ tailscaleAuthKey: 'tskey-auth-example' });
ok('带 Tailscale auth key 时写进脚本', withKey.includes('tskey-auth-example'));
// 这里不能靠 includes('may wait') 之类的「出现即通过」判断：那段文案在脚本
// 里始终存在，只有运行时才决定打不打印。要验证的是**控制流**：
//   - 有 authkey：authkey 那条路必须排在交互登录之前，且交互登录被跳过
//   - 无 authkey：必须有可照做的交互指引，且整体等待有上限
// 重构后结构从 `if ($TailscaleAuthKey) {} else {}` 变成
// `if (-not $tsIp -and $TailscaleAuthKey) {} if (-not $tsIp) {}`，
// 因为要先把「已经登录过」这一种情况短路掉。断言跟着意图走，
// 不要绑死某一种写法。
{
  const iKey = withKey.indexOf('--authkey');
  const iManual = withKey.indexOf('== Action needed: approve this machine in Tailscale ==');
  ok('authkey 路径存在且排在交互登录之前', iKey > 0 && iManual > iKey);
  ok('authkey 调用有超时上限', /--authkey[^\n]*-TimeoutSec \d+/.test(withKey));
}

const noKey = gen();
ok('不带 auth key 时脚本里 auth key 为空串', noKey.includes("$TailscaleAuthKey = ''"));
ok(
  '不带 auth key 时给出明确的交互指引',
  noKey.includes('== Action needed: approve this machine in Tailscale =='),
);
ok(
  '交互指引说明可在任意机器上浏览器打开',
  noKey.includes('it does not have'),
);
ok(
  '交互指引给出 auth key 的后备地址',
  noKey.includes('login.tailscale.com/admin/settings/keys'),
);
ok(
  '已登录时短路，不重复触发登录',
  noKey.includes('Tailscale already logged in'),
);
ok(
  '等待地址的轮询有上限且会报告状态',
  /for \(\$i = 1; \$i -le 60; \$i\+\+\)/.test(noKey) && noKey.includes('still waiting for an address after'),
);

const customPort = gen({ sshPort: 2222 });
ok('自定义 SSH 端口生效', customPort.includes('$SshPort        = 2222'));

const noName = gen({ agentName: '' });
ok('不指定名字时回退到主机名', noName.includes('$env:COMPUTERNAME'));

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
