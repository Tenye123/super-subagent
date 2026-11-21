// 自测：新架构（lib/dispatch-rpc.mjs）能否真的派活成功。
//
// 这个测试直接打真实设备。它不是单元测试——Connection RPC 的每一环
// （端口发现、cookie 自签、会话登记、事件解析）都只有在真机上才成立。
//
// 用法：node test/rpc-dispatch-test.mjs [设备名]

import * as cfg from '../lib/config.mjs';
import { dispatch } from '../lib/dispatch-rpc.mjs';

const name = process.argv[2] || 'laptop-a';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + (detail ? ' → ' + detail : ''));
  }
}

const conf = cfg.loadConfig();
const dev = cfg.findDevice(conf, name);
if (!dev) {
  console.error('找不到设备: ' + name + '；可用: ' + cfg.activeDevices(conf).map((d) => d.name).join(', '));
  process.exit(2);
}

console.log('设备 ' + dev.name + ' (' + dev.user + '@' + dev.tailscaleIp + ')');
console.log('');

const steps = [];
let r;
try {
  r = await dispatch(dev, 'Reply with exactly: RPC_TEST_OK', {
    cwd: dev.workspace || 'C:/Users/' + dev.user + '/dsh-workspace',
    timeoutMs: 300_000,
    onProgress: (m) => steps.push(m),
  });
} catch (e) {
  console.log('派活抛异常: ' + (e && e.message ? e.message : e));
  process.exit(1);
}

for (const s of steps) console.log('  · ' + s);
console.log('');

check('返回了 sessionId', Boolean(r.sessionId), r.sessionId);
check('会话已登记进 workspace', r.registered === true);
check('任务被接受', r.accepted === true);
check('本轮已结束', r.finished === true);
check('答案正确', r.answer === 'RPC_TEST_OK', JSON.stringify(r.answer));
check('有事件记录', r.eventCount > 0, String(r.eventCount));

console.log('');
console.log((fail === 0 ? '全部通过' : fail + ' 项失败') + '  (pass=' + pass + ' fail=' + fail + ')');
if (r && r.sessionId) console.log('session: ' + r.sessionId);
process.exit(fail === 0 ? 0 : 1);
