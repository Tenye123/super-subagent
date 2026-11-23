# super-subagent

把多台电脑组织成一台"会分身"的开发机。

> 项目内部代号 `dsh-fleet`，命令、包名、目录名都沿用这个前缀。

主控（controller）派活，代理（agent）干活。代理不是远程 shell，而是**有自己设备的子代理**——它有自己的文件系统、自己的网络位置、自己的已装工具和浏览器登录态。

```
        你
         │
    ┌────▼─────┐        mcp__fleet__fleet_run_task
    │  主控机   │ ────────────────────────────────┐
    │ controller│                                 │
    └──────────┘                                  │
                                           ┌──────▼──────┐
                                           │   代理机     │
                                           │   agent      │
                                           │  · 公司内网   │
                                           │  · 自己的磁盘 │
                                           │  · 自己的 DSH │
                                           └─────────────┘
```

方向是**单向**的：只有主控给代理派活。代理不能反过来指挥主控。

## 为什么不是远程桌面

| 方式 | 家庭版 Windows | 需要装东西 | 主控还能正常用 |
|---|---|---|---|
| RDP | ✗ 家庭版不能当服务端 | 系统组件 | 卡（独占会话/抢 GPU） |
| 向日葵 / ToDesk | ✓ | 第三方软件 | 卡，且公司资产装这类软件有合规风险 |
| **super-subagent** | ✓ | 只有 OpenSSH + Tailscale | **不卡**，代理干活不占主控资源 |

关键点：**代理上的工作不经过主控的 CPU/GPU/网络**。主控只发一条任务描述，代理用自己的算力跑完，回一段文本。主控的资源占用约等于一次 SSH 往返。

## 和"SSH 跑个命令"的区别

会话归属。

`ssh agent "dsh --print '...'"` 能拿到答案，但那次会话**不登记进任何 workspace**。你到代理机上打开 DSH 界面，什么都看不到——活干了，没法复查、没法接着追问。

super-subagent 走的是 DSH 桌面端自己的 Connection RPC：`workspace/create` → `session/create` → `session/prompt`。会话由应用自己的 `SessionController` 创建，所以**它出现在那边的界面上**，可以继续聊。

这是本项目的核心，也是最难的部分——细节见 [为什么这么实现](#为什么这么实现)。

## 安装

前置：控制端装 [Tailscale](https://tailscale.com/) 并登录；被控端不需要任何准备，
安装脚本会自己装 Node、OpenSSH Server 和 Tailscale。

### 控制端：装成一个 DSH 插件

```powershell
# 1. 把仓库放到本地任意位置，然后在 DSH 的 profile 里登记
#    （C:\Users\<你>\.dsh\profiles\desktop\package.json）
```

```jsonc
{
  "dependencies": {
    "dsh-super-subagent": "file:E:/mywork/dsh-fleet"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-super-subagent"]
    }
  }
}
```

重启 DSH。设置页里会出现 **超级子代理**，带一个图形界面：设备列表、添加设备、派活。

它同时会在 tailnet 上开一个报名端口（47321），用来接收新机器的自我注册。

### 被控端：一条命令

在设置页点 **添加设备**，复制那句命令，到目标机器上以管理员身份打开 PowerShell 粘贴：

```powershell
irm "http://100.x.x.x:47321/setup.ps1?id=xxxx" -OutFile "$env:TEMP\setup-agent.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\setup-agent.ps1"
```

跑完那台机器会自己出现在设备列表里，状态变成「可派活」。不需要手工抄 IP、配密钥、贴公钥。

它做七件事：装 Node → 装 OpenSSH Server → 装 Tailscale → 写入控制端公钥 →
把 sshd 绑到 tailnet 地址（不碰公司内网）→ 注册 sshd 自愈任务 → 向控制端报名。

> 最后那步「自愈」是为了解决一个真实故障：sshd 绑在 Tailscale 地址上，
> 但开机时它可能比 Tailscale 先启动，绑不上地址就退出，之后整台机器失联，
> 只能人到现场。自愈任务会在 Tailscale 就绪后把 sshd 拉起来。

### 保留的命令行方式

图形界面之外，命令行也能用（适合脚本化、或无 GUI 的场合）：

```powershell
node fleet.mjs install --role controller   # 初始化控制端
node fleet.mjs list                        # 看设备
node fleet.mjs ping laptop-a               # 探活
```

### MCP 工具（两种方式都保留）

除了插件界面，还可以把同一套能力接成 MCP 工具，在对话里直接调。
主控的 `cordis.patch.yml` 加一段：

```yaml
- id: mcp-fleet
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: fleet
    transport: stdio
    command: node
    args: ['<本仓库路径>/mcp/server.mjs']
    toolCallTimeoutMs: 1800000
```

重启主控的 DSH，就有了：

| 工具 | 作用 |
|---|---|
| `mcp__fleet__fleet_list_devices` | 列出已纳管的代理 |
| `mcp__fleet__fleet_scan` | 扫描 tailnet，判断哪些真能派活 |
| `mcp__fleet__fleet_add_device` | 生成新机器的接入命令 |
| `mcp__fleet__fleet_ping` | 探活 |
| `mcp__fleet__fleet_run_task` | 派活并等结果 |
| `mcp__fleet__fleet_jobs` | 历史任务 |

插件的界面和 MCP 工具共用 `lib/` 里的同一套实现，不存在两份逻辑。

## 用法

```powershell
fleet doctor                      # 体检：node / dsh / sshd / tailscale / 权限
fleet list                        # 列出所有代理
fleet ping --name laptop-a        # 连通性
fleet run --device laptop-a --task "编译 ztb-dataex"
fleet jobs                        # 历史任务
```

不装 MCP 也能用 CLI，两者走同一套实现。

### 「在线」和「可派活」不是一回事

界面上这两个状态严格分开，因为混在一起会让人对着"在线"的设备反复点派活却一直失败：

| 状态 | 含义 | 怎么办 |
|---|---|---|
| 可派活 | SSH 通 + 那边 DSH 桌面端在跑 | 直接用 |
| DSH 未启动 | SSH 通，但没有 DSH 桌面端进程 | 让对方打开 DSH |
| 连不上 | 22 端口不通 | sshd 没起来，或被防火墙拦了 |
| 未探测 | 在 tailnet 里可见，但未登记 | 用「添加设备」接入 |
| 离线 | tailnet 里显示不在线 | 对方关机或掉线 |

实测过这个区分的必要性：A 在 `tailscale status` 里显示 `online=true`，
但从控制端连它的 22 端口一直超时——sshd 绑在 Tailscale 地址上，
而那次开机时 Tailscale 还没拿到 IP，绑定失败后 sshd 退出了。

## 安全模型

代理**不开任何公网端口**，也不做 exit node 或 subnet route。通信只走 Tailscale 的私有网络。

### 密钥不是"一把万能钥匙"

`authorized_keys` 里每条都带限制：

```
restrict,expiry-time="202612201725",from="100.64.0.0/10,192.168.137.0/24" ssh-ed25519 AAAA...
```

- `restrict` —— 关掉端口转发、agent 转发、PTY、X11 等一切
- `expiry-time` —— 到期自动失效，不需要记得去删
- `from` —— 只接受来自 tailnet 网段的连接

撤销只需删掉一行，或者等它自己过期。

### 两种密钥用途

| 用途 | 权限 | 给谁 |
|---|---|---|
| `agent` | `restrict`，只能跑指定入口 | 命令行派活 |
| `ui` | `restrict` + `permitopen 127.0.0.1:<端口>` | 浏览器看任务登记表 |

`ui` key 即使泄露，攻击者也只在那一个端口上能做转发，拿不到 shell。

### 不放开 loopback

DSH 桌面端只监听 `127.0.0.1`，这是有意的设计。super-subagent 不去改它，而是借 SSH 隧道到那边再打 loopback——**不为了派活去削弱产品本身的安全边界**。

## 为什么这么实现

这一节记录的是踩过的坑。改动这些代码之前请先读，否则很容易把已修好的问题重新引入。

### 端口是随机的，不能写死

DSH 桌面端**每次启动随机选端口**。任何写进配置的端口只能活到下次重启，然后所有派活突然失败。

所以端口从「名为 `DeepSeek Harness` 的进程所持有的 LISTEN socket」现场发现。这是全链路唯一会过期的值，每次派活都重新问。

### 自签 cookie

`/api` 要求一个 `dsh-auth-<hash>` cookie。启动 token 只在进程内存里（一个 `WeakMap`），外部永远拿不到；但签名密钥持久化在 `.credentials.yaml` 里，所以可以自签：

```
cookie 名 = "dsh-auth-" + base64url(sha256(authority))
cookie 值 = "v1." + base64url(payload) + "." + base64url(HMAC-SHA256(secret, body))
payload   = { version:1, authority, issuedAt, expiresAt }
```

### 请求体必须恰好一个 args

`POST /api/<ns>/<method>` 的 `payload` 必须含**恰好一个** plain-object 的 `args` 字段。多一个少一个都会报 `Remote payload must contain exactly one plain-object args field`。

### 编码只做一次

`payload` 交给传输层时是**对象**，不是字符串。如果两头各 `JSON.stringify` 一次，服务端会回 `invalid client-request message`——看起来像协议不兼容，其实只是编了两遍。

### `session/page` 没有"取全部"

`throughSeq: -1` 表示"第一条事件之前"，返回**空集**，不是全部。真正的 cursor 只能靠故意越界拿到，错误信息里会给出：

```
session history cut <n> exceeds <cursor>
```

### 事件结构不止一层

响应里 `records` 是 `[{type:'event', event:{...}}]`，不是裸事件。assistant 的回复在：

```
event.data.message.content[].text   且 event.type === 'assistant/message'
```

少写一层就会永远读到空字符串，而且**看起来和"agent 什么都没说"一模一样**。

### workspace 路径必须完全限定

`workspace/create` 收到 `~/.dsh-workspace` 会报 `Workspace path is not fully qualified`。`~` 的展开取决于远端用户名，主控猜不出来，必须问远端。

另外默认工作目录**不能设成家目录**：DSH 的 Windows ACL 沙箱要求 temp root 在 workspace 之外，而家目录里包含 `AppData\Local\Temp`。设成家目录会让每条工具调用在启动前就失败：

```
Windows ACL temp root must be outside the workspace:
workspace=C:\Users\<user>; temp=C:\Users\<user>\AppData\Local\Temp
```

### 任务文本走 stdin，不走命令行

任务可以是任意内容——引号、换行、中文、反引号、`$` 都有。塞进命令行要经过 cmd → PowerShell → 程序三层引号解析，每一层都会坏。

所以远端信使程序从命令行进去（压成单行、不含双引号），**任务文本走 stdin**。stdin 不经过任何解析器。

### 模板字符串会吃反斜杠

如果要把远端程序内联进 JS 模板字符串，里面的 `\r?\n` 会变成真实换行（导致 `Unterminated regexp literal`），`\s\S` 会变成 `sS`（导致静默失配）。

**规则：模板字符串内一律不写反斜杠**，用 `String.fromCharCode(10)`、`[ ]`、`[0-9]` 代替。本项目栽在这上面三次。

### MCP server 不能在 stdin EOF 时退出

客户端常常写完请求就关管道。此时 `readline` 的 `close` 立刻触发，而派活是异步的、可能跑几分钟。无条件 `process.exit(0)` 会在任务中途杀掉进程，表现是**「只收到 initialize 的回复，tools/call 永远没有下文」**——看起来像协议不兼容，其实是被自己杀了。

所以要记账：既收到 EOF、又没有在飞的调用，才退出。

## 代理端开机自愈

派活依赖两样东西在开机后自己起来：**sshd 绑上 Tailscale 地址**，以及**DSH 桌面端在用户会话里运行**。这两件事在 Windows 上都不会自动成立，必须显式处理。

### 陷阱一：sshd 启动竞态

`sshd_config` 里可以写 `ListenAddress <tailnet-ip>`，但**开机时那个地址往往还不存在**：

```
tailscaled  启动于 09:39:16
sshd        启动于 09:39:17     ← 只差 1 秒
```

服务依赖（`sc.exe config sshd depend= Tailscale`）只保证**启动顺序**，不保证 Tailscale 已经把 `100.x` 地址挂到网卡上。sshd 启动时绑定失败，静默退回只绑 `127.0.0.1`，**之后永不重试**。

诊断只需要一条命令：

```powershell
Get-NetTCPConnection -LocalPort 22 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
```

修复前只有 `127.0.0.1`，没有 `100.x`。而 `sshd -t` 返回 0 且无输出——**配置本身没错，错在运行态绑定**。所以不要从配置文件里找答案。

更隐蔽的是：`OpenSSH/Operational` 事件日志会明确记下它只监听回环：

```
9:39:17  sshd: Server listening on 127.0.0.1 port 22.
```

**这个问题每次开机都会复现**，不是偶发。

### 陷阱二：自愈脚本只报警不修复

机器上可能已经存在一个自愈脚本，但要检查它是否真的会动手。曾见过这样的分支：

```powershell
if ($onTs.Count -eq 0) {
  Say "sshd is running but not listening on the tailscale address"
  exit 1        # ← 发现了故障，写条日志就退出
}
```

日志里留下准确记录、然后什么都不做，比没有脚本更危险——它制造了"有人在管这件事"的错觉。

**正确写法是主动重启**（此时 Tailscale 地址已就绪）：

```powershell
if ($onTs.Count -eq 0) {
  Say "sshd is running but not listening on the tailscale address; restarting sshd"
  Restart-Service sshd -Force
  Start-Sleep -Seconds 3
  # 重新读取监听地址确认已恢复
}
```

配合 **BootTrigger**（延迟 1 分钟，之后每 5 分钟重试），而不是一次性的 `TimeTrigger`。

### 陷阱三：DSH 不开机自启

DSH 桌面端的开机自启常常是**名义上有、实际无效**——指向未来某一天的 `TimeTrigger`：

```xml
<TimeTrigger>
  <StartBoundary>2027-11-20T20:55:47+08:00</StartBoundary>   <!-- 2027 年才跑一次 -->
</TimeTrigger>
```

重启后它永远不会触发。应该用 `LogonTrigger`：

```xml
<LogonTrigger>
  <Enabled>true</Enabled>
  <UserId>HOST\user</UserId>
  <Delay>PT15S</Delay>        <!-- 等登录瞬间的资源竞争过去 -->
</LogonTrigger>
```

同时必须把 `StopOnIdleEnd` 设为 `false`——默认值 `true` 会在系统空闲 10 分钟后**杀掉 DSH**。

### 陷阱四：DSH 需要登录会话

DSH 是 Electron 桌面程序，`desktop-host` 跑在**用户会话**里（`SessionId=1`），不是 session 0。headless profile 只提供 CLI，**不提供 fleet 派活所需的 RPC 服务**。

所以「开机自启」必须配「自动登录」，否则机器停在登录界面，DSH 不会起来：

```
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon
  AutoAdminLogon    = 1
  DefaultUserName   = <user>
  DefaultDomainName = .
  DefaultPassword   = <明文>        ← Windows 自动登录只能明文，没有加密方案
```

这是安全性上的真实代价，需要明确接受。选择「不自动登录」也是合理的：那样重启后人工登录一次即可。

### 锁屏会挡住什么

锁屏**不结束会话**，进程继续运行，所以 SSH、派活、读写文件、改注册表全部照常。挡住的只有**需要交互式桌面的操作**——截图、模拟键鼠。

若要让 DSH 在锁屏后仍可被观察，用组策略彻底禁用锁屏：

```powershell
New-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' `
  -Name NoLockScreen -Value 1 -PropertyType DWord -Force
```

这是**策略级**设置，优先级高于 ToDesk 之类远程工具自己调用的锁屏 API。代价是屏幕内容始终敞开，需要自行权衡。

### 验证方式

重启后逐项核对，缺一不可：

| 检查 | 命令 | 期望 |
|---|---|---|
| 确实重启了 | `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime` | 更新时间戳 |
| 自动登录成功 | `Get-Process LogonUI` + `query user` | 无 `LogonUI`，会话 `Active` |
| DSH 起来了 | `Get-Process 'DeepSeek Harness'` | 进程存在 |
| **端口活着** | 见下 | 有任意 LISTEN 端口 |
| SSH 绑对地址 | `Get-NetTCPConnection -LocalPort 22 -State Listen` | 回环 + `100.x`，**无** `0.0.0.0` |

```powershell
# 不要查固定端口号——每次启动都变
$p = @(Get-Process 'DeepSeek Harness').Id
Get-NetTCPConnection -State Listen | Where-Object { $p -contains $_.OwningProcess }
```

实测一次完整冷启动：断开到恢复 **90 秒**，其中自愈任务在开机 78 秒时检测到问题并重启 sshd，DSH 在开机 34 秒时由登录触发拉起。

## 测试

```powershell
npm test              # 全部
npm run test:rpc      # 只测 Connection RPC 派活（需要真实代理在线）
```

`test/rpc-dispatch-test.mjs` 不是单元测试——端口发现、cookie 自签、会话登记、事件解析，每一环都只有在真机上才成立。它会真的建一个会话。

其余测试覆盖 SSH 加固、密钥格式、注入防护、MCP 协议协商、PowerShell 编码等不需要远端的部分。

## 已知限制

- **只支持 Windows**。沿用 Windows 的 SSH 加固、ACL 和 PowerShell。Linux/macOS 代理还没做。
- **代理上必须有 DSH 桌面端且在运行**。只有 CLI 不够——CLI 不提供 `/api` 服务。
- **DSH 需要登录会话**。它是 Electron 桌面程序，服务端跑在用户会话里。要做到无人值守，必须配自动登录（注册表明文密码）；不配则重启后需人工登录一次。
- **sshd 绑定 Tailscale 地址存在开机竞态**。每次开机都可能只绑到 `127.0.0.1`，必须靠自愈任务补救。这是 Windows 服务启动顺序与 Tailscale 地址分配之间的固有竞争，无法纯靠配置消除。
- **一次一个任务**。同一代理并发派活没做排队，会各自建会话。
- **会话续接未完成**。`--session` 参数目前只是记录了 id，没有真的往已有会话里追加。
- 桌面端每次重启要重新发现端口，所以派活比纯 SSH 多一次往返。**端口号每次都变，任何地方都不要写死**。

## 许可

MIT
