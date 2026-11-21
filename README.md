# dsh-fleet

把多台电脑组织成一台"会分身"的开发机。

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
| **dsh-fleet** | ✓ | 只有 OpenSSH + Tailscale | **不卡**，代理干活不占主控资源 |

关键点：**代理上的工作不经过主控的 CPU/GPU/网络**。主控只发一条任务描述，代理用自己的算力跑完，回一段文本。主控的资源占用约等于一次 SSH 往返。

## 和"SSH 跑个命令"的区别

会话归属。

`ssh agent "dsh --print '...'"` 能拿到答案，但那次会话**不登记进任何 workspace**。你到代理机上打开 DSH 界面，什么都看不到——活干了，没法复查、没法接着追问。

dsh-fleet 走的是 DSH 桌面端自己的 Connection RPC：`workspace/create` → `session/create` → `session/prompt`。会话由应用自己的 `SessionController` 创建，所以**它出现在那边的界面上**，可以继续聊。

这是本项目的核心，也是最难的部分——细节见 [为什么这么实现](#为什么这么实现)。

## 安装

前置：两台机器都装 [Tailscale](https://tailscale.com/)，都在同一个 tailnet 里。Node ≥ 20。

### 主控

```powershell
node fleet.mjs install --role controller
```

### 代理

```powershell
node fleet.mjs install --role agent
```

一次装完：Node 检查、DSH、Tailscale、OpenSSH Server、`sshd_config` 加固、防火墙收紧、密钥生成、电源设置（不休眠）、开机自启。

### 纳管一台代理

在代理上装完会打印一段 `fleet accept ...` 命令，把它拿到主控上执行：

```powershell
fleet enroll --name laptop-a --ip 100.x.x.x --user hp --expires 30d
```

然后在代理上批准：

```powershell
fleet accept --controller my-pc --pubkey "ssh-ed25519 AAAA..." --expires 30d
```

### 接到 DSH 里当工具用

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
| `mcp__fleet__fleet_ping` | 探活 |
| `mcp__fleet__fleet_run_task` | 派活并等结果 |
| `mcp__fleet__fleet_jobs` | 历史任务 |

## 用法

```powershell
fleet doctor                      # 体检：node / dsh / sshd / tailscale / 权限
fleet list                        # 列出所有代理
fleet ping --name laptop-a        # 连通性
fleet run --device laptop-a --task "编译 ztb-dataex"
fleet jobs                        # 历史任务
```

不装 MCP 也能用 CLI，两者走同一套实现。

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

DSH 桌面端只监听 `127.0.0.1`，这是有意的设计。dsh-fleet 不去改它，而是借 SSH 隧道到那边再打 loopback——**不为了派活去削弱产品本身的安全边界**。

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
- **一次一个任务**。同一代理并发派活没做排队，会各自建会话。
- **会话续接未完成**。`--session` 参数目前只是记录了 id，没有真的往已有会话里追加。
- 桌面端每次重启要重新发现端口，所以派活比纯 SSH 多一次往返。

## 许可

MIT
