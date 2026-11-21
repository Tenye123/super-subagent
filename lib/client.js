/**
 * super-subagent —— 浏览器端（DSH 设置页的一个 section）
 *
 * 它只做三件事，每件都对应一个用户真的会卡住的地方：
 *
 *   1. 加设备 —— 生成一条命令，复制到目标机器上跑，装完自动出现。
 *      取代"手工抄 IP、配密钥、贴公钥"那套。
 *
 *   2. 看状态 —— 明确区分「看得见」（在 tailnet 里）和「可派活」
 *      （端口通 + DSH 在跑 + 我们能上去）。这两件事经常不一致，
 *      混在一起显示会让用户对着"在线"的设备反复点派活。
 *
 *   3. 派活 —— 输入一句话，后台跑，界面轮询进度。
 *
 * 数据全部来自 Host 半边的本地 API（127.0.0.1:6210）。不直接碰 SSH，
 * 也不在浏览器里存任何密钥。
 */
window.__ModuleLoader__.load({
  id: 'dsh-super-subagent',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const NS = 'super-subagent';
    const API = 'http://127.0.0.1:6210';

    const zh = {
      nav: '超级子代理',
      title: '超级子代理',
      intro:
        '把多台电脑组成一个集群：这台派活，其余在自己机器上干活，会话留在那边的界面上可以接着用。',
      self: '本机',
      tailscaleOk: 'Tailscale 已连接',
      tailscaleDown: 'Tailscale 未连接',
      devices: '设备',
      noDevices: '还没有设备。点下面的按钮加一台。',
      addDevice: '添加设备',
      addTitle: '把一台新电脑接进来',
      addStep1: '在目标电脑上以管理员身份打开 PowerShell',
      addStep2: '粘贴下面这条命令并回车',
      addStep3: '等它跑完，装好后会自动出现在列表里',
      copy: '复制命令',
      copied: '已复制',
      generating: '正在生成…',
      genFailed: '生成失败',
      advanced: '高级选项',
      // 这是最容易卡住用户的一处：全新机器还没进 tailnet，就下不到脚本。
      // 默认按"全新机器"处理，因为这是最常见的情况。
      freshMachine: '这台电脑还不在 Tailscale 网络里',
      freshMachineHint: '全新电脑选这个。命令会从局域网地址下载。',
      alreadyInNet: '已经在 Tailscale 网络里',
      alreadyInNetHint: '重装或补装才选这个。走 tailnet 地址，更安全。',
      lanAddress: '局域网地址',
      lanAddressHint: '目标电脑要能访问到这个地址。虚拟机通常选 VMnet 那个。',
      expiresIn: '这条命令 %s 分钟内有效',
      regenerating: '重新生成',
      downloadVia: '下载方式',
      viaTailnet: '经 Tailscale 网络',
      viaLan: '经局域网（临时通道）',
      lanWarning: '这条通道只用于下载脚本，送到后会立即关闭。期间同一网段的人若能猜到链接就能下到脚本，用完请重新生成一次以作废。',
      deviceName: '设备名（留空则用对方主机名）',
      sshPort: 'SSH 端口',
      authKey: 'Tailscale 授权密钥（可选，填了就免去浏览器登录）',
      close: '关闭',
      scan: '扫描网络',
      scanning: '扫描中…',
      ready: '可派活',
      unprobed: '未探测',
      offline: '离线',
      unreachable: '连不上',
      noDsh: 'DSH 未启动',
      enrolled: '已登记',
      notEnrolled: '未登记',
      run: '派活',
      runTitle: '派一个任务',
      runPlaceholder: '描述要做什么，越具体越好。例如：看一下 D 盘还剩多少空间',
      runCwd: '工作目录（留空用默认的 dsh-workspace）',
      runGo: '开始',
      running: '执行中…',
      done: '完成',
      failed: '失败',
      taskResult: '结果',
      taskSteps: '过程',
      remove: '移除',
      removeConfirm: '确定不再管理这台设备？（不会改动对方机器上的任何东西）',
      unreachableApi:
        '连不上插件的本地服务（127.0.0.1:6210）。若是刚装好，重启一次 Harness。',
      refresh: '刷新',
      detail: '详情',
      lastSeen: '最后在线',
      os: '系统',
      ip: '地址',
      copyIpHint: '地址可从左侧复制',
    };

    const en = {
      nav: 'Super Subagent',
      title: 'Super Subagent',
      intro:
        'Turn several computers into one fleet: this one dispatches, the others work on their own machines, and sessions stay there for later.',
      self: 'This machine',
      tailscaleOk: 'Tailscale connected',
      tailscaleDown: 'Tailscale not connected',
      devices: 'Devices',
      noDevices: 'No devices yet. Add one below.',
      addDevice: 'Add device',
      addTitle: 'Bring a new computer in',
      addStep1: 'Open an elevated PowerShell on the target computer',
      addStep2: 'Paste the command below and press Enter',
      addStep3: 'When it finishes, the machine shows up here by itself',
      copy: 'Copy command',
      copied: 'Copied',
      generating: 'Generating…',
      genFailed: 'Failed to generate',
      advanced: 'Advanced',
      freshMachine: 'This computer is not on Tailscale yet',
      freshMachineHint: 'Pick this for a brand new machine. The command downloads over LAN.',
      alreadyInNet: 'Already on Tailscale',
      alreadyInNetHint: 'Only for re-installs. Uses the tailnet address, which is safer.',
      lanAddress: 'LAN address',
      lanAddressHint: 'The target must be able to reach this address. VMs usually pick the VMnet one.',
      expiresIn: 'This command is valid for %s minutes',
      regenerating: 'Regenerate',
      downloadVia: 'Delivery',
      viaTailnet: 'Over Tailscale',
      viaLan: 'Over LAN (temporary channel)',
      lanWarning: 'This channel only serves the script and closes as soon as it is delivered. Anyone on the same subnet who guesses the link could fetch it meanwhile; regenerate afterwards to void it.',
      deviceName: 'Device name (blank uses its hostname)',
      sshPort: 'SSH port',
      authKey: 'Tailscale auth key (optional, skips the browser login)',
      close: 'Close',
      scan: 'Scan network',
      scanning: 'Scanning…',
      ready: 'Ready',
      unprobed: 'Not probed',
      offline: 'Offline',
      unreachable: 'Unreachable',
      noDsh: 'DSH not running',
      enrolled: 'Enrolled',
      notEnrolled: 'Not enrolled',
      run: 'Dispatch',
      runTitle: 'Dispatch a task',
      runPlaceholder: 'Describe the task. Be specific. e.g. check free space on drive D',
      runCwd: 'Working directory (blank uses dsh-workspace)',
      runGo: 'Start',
      running: 'Running…',
      done: 'Done',
      failed: 'Failed',
      taskResult: 'Result',
      taskSteps: 'Steps',
      remove: 'Remove',
      removeConfirm: 'Stop managing this device? Nothing on that machine is changed.',
      unreachableApi:
        'Cannot reach the plugin service on 127.0.0.1:6210. If you just installed it, restart Harness once.',
      refresh: 'Refresh',
      detail: 'Details',
      lastSeen: 'Last seen',
      os: 'OS',
      ip: 'Address',
      copyIpHint: 'Copy the address from the left',
    };

    /* ---------------- 请求辅助 ---------------- */

    /**
     * 调本地 API。
     *
     * 失败时把 HTTP 状态和错误正文都带出来——这个插件的失败大多来自
     * 环境（Tailscale 没连、端口被占、密钥缺失），只说"请求失败"
     * 等于什么都没说。
     */
    async function api(path, { method = 'GET', body } = {}) {
      const opt = { method, headers: {} };
      if (body !== undefined) {
        opt.headers['content-type'] = 'application/json';
        opt.body = JSON.stringify(body);
      }
      const res = await fetch(API + path, opt);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('服务返回的不是 JSON（HTTP ' + res.status + '）: ' + text.slice(0, 200));
      }
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || 'HTTP ' + res.status);
      }
      return json;
    }

    /* ---------------- 样式 ---------------- */

    const S = {
      wrap: { padding: '4px 0 24px' },
      heading: { fontSize: 18, fontWeight: 600, margin: '0 0 6px' },
      intro: { fontSize: 13, opacity: 0.7, margin: '0 0 18px', lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.22))',
        borderRadius: 10,
        padding: 14,
        marginBottom: 12,
      },
      row: { display: 'flex', alignItems: 'center', gap: 10 },
      bar: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
      grow: { flex: 1 },
      label: { fontSize: 12, opacity: 0.65, marginBottom: 4, display: 'block' },
      input: {
        width: '100%',
        padding: '7px 10px',
        fontSize: 13,
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-1, transparent)',
        color: 'inherit',
        boxSizing: 'border-box',
      },
      button: {
        padding: '7px 14px',
        fontSize: 13,
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-1, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primary: {
        padding: '7px 14px',
        fontSize: 13,
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-brand-primary, #3068d0)',
        background: 'var(--dsw-alias-brand-primary, #3068d0)',
        color: '#fff',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      danger: {
        padding: '5px 10px',
        fontSize: 12,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-state-danger-primary, #d03050)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-danger-primary, #d03050)',
        cursor: 'pointer',
      },
      small: { fontSize: 12, opacity: 0.65 },
      mono: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12,
        background: 'var(--dsw-alias-bg-2, rgba(128,128,128,.1))',
        padding: 10,
        borderRadius: 7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        lineHeight: 1.5,
        maxHeight: 220,
        overflow: 'auto',
      },
      err: {
        fontSize: 12,
        color: 'var(--dsw-alias-state-danger-primary, #d03050)',
        background: 'var(--dsw-alias-bg-2, rgba(208,48,80,.08))',
        padding: '8px 10px',
        borderRadius: 7,
        marginBottom: 10,
        lineHeight: 1.5,
      },
      dot: (on) => ({
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: on
          ? 'var(--dsw-alias-state-success-primary, #18a058)'
          : 'var(--dsw-alias-state-danger-primary, #d03050)',
        flexShrink: 0,
      }),
      chip: (on) => ({
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 20,
        background: on
          ? 'var(--dsw-alias-state-success-primary, #18a058)'
          : 'var(--dsw-alias-bg-2, rgba(128,128,128,.18))',
        color: on ? '#fff' : 'inherit',
        whiteSpace: 'nowrap',
      }),
    };

    /* ---------------- 小组件 ---------------- */

    function Field({ label, children }) {
      return h('div', { style: { marginBottom: 10 } }, h('label', { style: S.label }, label), children);
    }

    function Err({ children }) {
      if (!children) return null;
      return h('div', { style: S.err }, String(children));
    }

    /* ---------------- 添加设备对话框 ---------------- */

    function AddDevice({ t, status, onClose, onDone }) {
      const [script, setScript] = React.useState('');
      const [genId, setGenId] = React.useState('');
      const [busy, setBusy] = React.useState(true);
      const [err, setErr] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const [showAdv, setShowAdv] = React.useState(false);
      const [name, setName] = React.useState('');
      const [port, setPort] = React.useState('22');
      const [authKey, setAuthKey] = React.useState('');

      // 默认按"全新机器"处理。
      //
      // 为什么不默认走 tailnet：全新机器还没装 Tailscale，访问不到 100.x
      // 地址，而装 Tailscale 正是脚本第 3 步。默认走 tailnet 会让绝大多数
      // 人拿到一条永远连不上的命令，且报错是"连不上"，完全看不出原因。
      const [fresh, setFresh] = React.useState(true);
      const [lanAddress, setLanAddress] = React.useState('');
      const [lanList, setLanList] = React.useState([]);
      const [via, setVia] = React.useState('lan');
      const [downloadUrl, setDownloadUrl] = React.useState('');

      const gen = React.useCallback(async () => {
        setBusy(true);
        setErr('');
        try {
          const r = await api('/bootstrap', {
            method: 'POST',
            body: {
              agentName: name.trim(),
              sshPort: Number(port) || 22,
              tailscaleAuthKey: authKey.trim(),
              deliverTo: fresh ? 'lan' : 'tailnet',
              lanAddress: lanAddress,
            },
          });
          setScript(r.script);
          // 服务端按这个 id 缓存了脚本，/setup.ps1?id=... 才能取到。
          setGenId(r.genId || '');
          setLanList(r.lanAddresses || []);
          setVia(r.deliverVia || 'tailnet');
          setDownloadUrl(r.downloadUrl || '');
          if (r.lanAddress && !lanAddress) setLanAddress(r.lanAddress);
        } catch (e) {
          setErr(String(e.message || e));
          setScript('');
        } finally {
          setBusy(false);
        }
      }, [name, port, authKey, fresh, lanAddress]);

      React.useEffect(() => {
        gen();
        // 只在挂载时生成一次；改选项后由用户点"重新生成"
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(script);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setErr('浏览器拒绝写入剪贴板，请手动全选下面的内容复制');
        }
      };

      // 用户真正需要粘贴的只有一行，不能让用户去处理 300 多行的脚本。
      //
      // 这里曾经有个真实缺陷：地址写死成 tailnet 地址（100.x:47321）。
      // 但一台**还没进 tailnet** 的机器访问不到它 —— 而装 Tailscale 正是
      // 脚本第 3 步。于是全新机器拿到的是一条永远连不上的命令，用户只能
      // 看到"连不上"，完全看不出原因。
      //
      // 现在按服务端返回的 deliverVia 决定用哪个地址：
      //   tailnet  目标已在 tailnet（重装/补装）→ 100.x:47321
      //   lan      目标是全新机器 → 局域网地址:47322（临时一次性通道）
      //
      // 端口不能混：6210 只绑回环，是给本机设置页调 API 的，别的机器访问不到。
      const ctrlIp = status && status.self ? status.self.tailscaleIp : '';
      // 抛给用户的是「一条能粘进管理员 PowerShell 就完事」的命令。
      //
      // 三个细节都是实测踩出来的，别顺手改回去：
      //   1. 用 iwr 而不是 irm。irm 返回字符串，配合管道执行在部分机器的
      //      执行策略下会被拦；iwr 只下载，不执行。
      //   2. 下载和执行分成两条语句，中间用 if 判断文件是否真的落地。
      //      原来用 ; 硬连，下载失败时第二条会抛
      //      CommandNotFoundException，用户看不出到底是没下载还是路径错。
      //   3. 执行必须带 -ep bypass。Windows 默认 Restricted，
      //      & "$env:TEMP\x.ps1" 会直接报「禁止运行脚本」，
      //      而那个提示长得像系统错误，用户会以为装不了了。
      const agentPath = '"$env:TEMP\\setup-agent.ps1"';
      const dlUrl = downloadUrl
        ? downloadUrl
        : ctrlIp
          ? 'http://' + ctrlIp + ':47321/setup.ps1?id=' + encodeURIComponent(genId)
          : '';
      const oneLiner = dlUrl
        ? 'iwr "' + dlUrl + '" -OutFile ' + agentPath + '; ' +
          'if (Test-Path ' + agentPath + ') { powershell -ep bypass -f ' + agentPath + ' }'
        : '';

      // 下载方式选择器。默认"全新机器"，因为那是最常见的情况，
      // 也是唯一不这么设就会失败的情况。
      const chooser = h('div', { style: { marginBottom: 12 } },
        h(Field, { label: t('downloadVia') },
          h('div', { style: S.row },
            h('label', { style: { ...S.small, marginRight: 14, cursor: 'pointer' } },
              h('input', {
                type: 'radio',
                checked: fresh,
                onChange: () => { setFresh(true); },
                style: { marginRight: 5 },
              }),
              t('freshMachine')),
            h('label', { style: { ...S.small, cursor: 'pointer' } },
              h('input', {
                type: 'radio',
                checked: !fresh,
                onChange: () => { setFresh(false); },
                style: { marginRight: 5 },
              }),
              t('alreadyInNet')),
          ),
          h('div', { style: { ...S.small, opacity: 0.7, marginTop: 3 } },
            fresh ? t('freshMachineHint') : t('alreadyInNetHint')),
        ),

        fresh && lanList.length
          ? h(Field, { label: t('lanAddress') },
              h('select', {
                style: S.input,
                value: lanAddress,
                onChange: (e) => setLanAddress(e.target.value),
              },
                lanList.map((a) =>
                  h('option', { key: a.address, value: a.address },
                    a.address + '  (' + a.iface + ')'))),
              h('div', { style: { ...S.small, opacity: 0.7, marginTop: 3 } },
                t('lanAddressHint')),
            )
          : null,

        h('div', { style: S.row },
          h('button', {
            style: S.button,
            onClick: () => gen(),
            disabled: busy,
          }, t('regenerating')),
          h('div', { style: S.grow }),
          h('span', { style: { ...S.small, opacity: 0.7 } },
            via === 'lan' ? t('viaLan') : t('viaTailnet')),
        ),

        via === 'lan'
          ? h('div', { style: { ...S.small, opacity: 0.75, marginTop: 8, lineHeight: 1.6 } },
              t('lanWarning'))
          : null,
      );

      return h(
        'div',
        { style: S.card },
        h('div', { style: { ...S.row, marginBottom: 10 } },
          h('strong', { style: { fontSize: 14 } }, t('addTitle')),
          h('div', { style: S.grow }),
          h('button', { style: S.button, onClick: onClose }, t('close')),
        ),

        h(Err, null, err),

        h('div', { style: { ...S.small, lineHeight: 1.9, marginBottom: 10 } },
          h('div', null, '1. ' + t('addStep1')),
          h('div', null, '2. ' + t('addStep2')),
          h('div', null, '3. ' + t('addStep3')),
        ),

        chooser,

        busy
          ? h('div', { style: S.small }, t('generating'))
          : script
            ? h(React.Fragment, null,
                h('div', { style: { ...S.mono, maxHeight: 90 } }, oneLiner),
                h('div', { style: { ...S.row, marginTop: 10 } },
                  h('button', { style: S.primary, onClick: copy },
                    copied ? t('copied') : t('copy')),
                  h('button', { style: S.button, onClick: () => setShowAdv(!showAdv) },
                    t('advanced')),
                  h('div', { style: S.grow }),
                  h('button', { style: S.button, onClick: onDone }, t('scan')),
                ),
                showAdv
                  ? h('div', { style: { marginTop: 12 } },
                      h(Field, { label: t('deviceName') },
                        h('input', {
                          style: S.input,
                          value: name,
                          placeholder: 'laptop-b',
                          onChange: (e) => setName(e.target.value),
                        })),
                      h(Field, { label: t('sshPort') },
                        h('input', {
                          style: S.input,
                          value: port,
                          onChange: (e) => setPort(e.target.value),
                        })),
                      h(Field, { label: t('authKey') },
                        h('input', {
                          style: S.input,
                          value: authKey,
                          placeholder: 'tskey-auth-...',
                          onChange: (e) => setAuthKey(e.target.value),
                        })),
                      h('button', { style: S.button, onClick: gen }, t('refresh')),
                      h('div', { style: { ...S.small, marginTop: 8, lineHeight: 1.6 } },
                        '改完选项要点一次「刷新」重新生成，命令才会更新。'),
                    )
                  : null,
              )
            : null,
      );
    }

    /* ---------------- 派活对话框 ---------------- */

    function RunTask({ t, device, onClose }) {
      const [task, setTask] = React.useState('');
      const [cwd, setCwd] = React.useState('');
      const [id, setId] = React.useState('');
      const [rec, setRec] = React.useState(null);
      const [err, setErr] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      // 轮询任务状态。只在有 id 且还没结束时跑。
      React.useEffect(() => {
        if (!id) return undefined;
        let alive = true;
        const tick = async () => {
          try {
            const r = await api('/tasks?id=' + encodeURIComponent(id));
            if (!alive) return;
            setRec(r.task);
            if (r.task.state === 'running') {
              setTimeout(tick, 1500);
            }
          } catch (e) {
            if (alive) setErr(String(e.message || e));
          }
        };
        tick();
        return () => {
          alive = false;
        };
      }, [id]);

      const go = async () => {
        if (!task.trim()) return;
        setBusy(true);
        setErr('');
        try {
          const r = await api('/run', {
            method: 'POST',
            body: { device: device.name, task: task.trim(), cwd: cwd.trim() },
          });
          setId(r.taskId);
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setBusy(false);
        }
      };

      const state = rec ? rec.state : '';
      const answer =
        rec && rec.result && typeof rec.result === 'object'
          ? rec.result.answer || rec.result.text || ''
          : '';

      return h(
        'div',
        { style: S.card },
        h('div', { style: { ...S.row, marginBottom: 10 } },
          h('strong', { style: { fontSize: 14 } }, t('runTitle') + ' → ' + device.name),
          h('div', { style: S.grow }),
          h('button', { style: S.button, onClick: onClose }, t('close')),
        ),

        h(Err, null, err),

        !id
          ? h(React.Fragment, null,
              h('textarea', {
                style: { ...S.input, minHeight: 80, resize: 'vertical' },
                value: task,
                placeholder: t('runPlaceholder'),
                onChange: (e) => setTask(e.target.value),
              }),
              h('div', { style: { height: 8 } }),
              h('input', {
                style: S.input,
                value: cwd,
                placeholder: t('runCwd'),
                onChange: (e) => setCwd(e.target.value),
              }),
              h('div', { style: { ...S.row, marginTop: 10 } },
                h('button', {
                  style: busy ? { ...S.primary, opacity: 0.6 } : S.primary,
                  onClick: go,
                  disabled: busy,
                }, busy ? t('generating') : t('runGo')),
              ),
            )
          : null,

        id
          ? h(React.Fragment, null,
              h('div', { style: { ...S.row, marginBottom: 10 } },
                h('span', { style: S.chip(state === 'done') },
                  state === 'running' ? t('running') : state === 'done' ? t('done') : t('failed')),
                h('div', { style: S.grow }),
                h('span', { style: S.small }, id),
              ),
              rec && rec.sessionId
                ? h('div', { style: { ...S.small, marginBottom: 8 } }, '会话: ' + rec.sessionId)
                : null,
              answer
                ? h('div', null,
                    h('div', { style: S.label }, t('taskResult')),
                    h('div', { style: S.mono }, answer),
                  )
                : null,
              rec && rec.steps && rec.steps.length
                ? h('details', { style: { marginTop: 10 } },
                    h('summary', { style: { ...S.small, cursor: 'pointer' } }, t('taskSteps')),
                    h('div', { style: { ...S.mono, marginTop: 8, maxHeight: 160 } },
                      rec.steps.join('\n')),
                  )
                : null,
              rec && rec.error
                ? h('div', { style: { ...S.err, marginTop: 10 } }, rec.error)
                : null,
            )
          : null,
      );
    }

    /* ---------------- 主界面 ---------------- */

    function Section() {
      const ctx = React.useContext(LocaleCtx);
      const t = ctx ? ctx.t : (k) => k;

      const [status, setStatus] = React.useState(null);
      const [list, setList] = React.useState([]);
      const [err, setErr] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [adding, setAdding] = React.useState(false);
      const [running, setRunning] = React.useState(null);

      const load = React.useCallback(async (scan) => {
        setErr('');
        try {
          const s = await api('/status');
          setStatus(s);
          if (scan) {
            setBusy(true);
            const r = await api('/scan');
            setList(r.devices || []);
          } else {
            const r = await api('/devices');
            // 未扫描时用已登记的设备填充，状态标成"未探测"
            setList(
              (r.devices || []).map((d) => ({
                ...d,
                enrolled: true,
                state: 'unprobed',
                stateLabel: '未探测',
                detail: '',
              })),
            );
          }
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        load(true);
        // 只在挂载时跑一次；后续由用户点刷新
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const remove = async (name) => {
        if (!window.confirm(t('removeConfirm'))) return;
        try {
          await api('/devices', { method: 'DELETE', body: { name } });
          load(true);
        } catch (e) {
          setErr(String(e.message || e));
        }
      };

      const badge = (state) => {
        const map = {
          ready: [true, t('ready')],
          unprobed: [false, t('unprobed')],
          unreachable: [false, t('unreachable')],
          'no-dsh': [false, t('noDsh')],
          offline: [false, t('offline')],
        };
        const [on, label] = map[state] || [false, state || '?'];
        return h('span', { style: S.chip(on) }, label);
      };

      const ip = status && status.self ? status.self.tailscaleIp : null;

      return h(
        'div',
        { style: S.wrap },

        h('h2', { style: S.heading }, t('title')),
        h('p', { style: S.intro }, t('intro')),

        h(Err, null, err),

        // 本机状态：Taillscale 没连时，除了加设备以外的功能都用不了，
        // 所以放在最上面显眼处，而不是藏在角落。
        h('div', { style: { ...S.row, marginBottom: 14, flexWrap: 'wrap', gap: 14 } },
          h('span', { style: S.row },
            h('span', { style: S.dot(status && status.self && status.self.tailscaleUp) }),
            h('span', { style: S.small },
              t('self') + ': ' + (status && status.self ? status.self.host : '…') +
              (ip ? ' · ' + ip : '')),
          ),
          h('span', { style: S.small },
            (status && status.self && status.self.tailscaleUp)
              ? t('tailscaleOk')
              : t('tailscaleDown')),
        ),

        h('div', { style: S.bar },
          h('button', { style: S.primary, onClick: () => setAdding(true) }, t('addDevice')),
          h('button', {
            style: busy ? { ...S.button, opacity: 0.6 } : S.button,
            onClick: () => load(true),
            disabled: busy,
          }, busy ? t('scanning') : t('scan')),
          h('div', { style: S.grow }),
          h('span', { style: S.small }, t('devices') + ': ' + list.length),
        ),

        adding
          ? h(AddDevice, {
              t,
              status,
              onClose: () => setAdding(false),
              onDone: () => {
                setAdding(false);
                load(true);
              },
            })
          : null,

        running
          ? h(RunTask, {
              t,
              device: running,
              onClose: () => {
                setRunning(null);
                load(true);
              },
            })
          : null,

        list.length === 0
          ? h('div', { style: { ...S.card, ...S.small } }, t('noDevices'))
          : list.map((d) =>
              h(
                'div',
                { key: d.tailscaleIp || d.name, style: S.card },
                h('div', { style: S.row },
                  h('span', { style: S.dot(d.state === 'ready') }),
                  h('strong', { style: { fontSize: 14 } }, d.name),
                  badge(d.state),
                  d.enrolled
                    ? h('span', { style: S.small }, t('enrolled'))
                    : h('span', { style: S.small }, t('notEnrolled')),
                  h('div', { style: S.grow }),
                  d.enrolled
                    ? h('button', { style: S.primary, onClick: () => setRunning(d) }, t('run'))
                    : null,
                  d.enrolled
                    ? h('button', { style: S.danger, onClick: () => remove(d.name) }, t('remove'))
                    : null,
                ),
                h('div', { style: { ...S.small, marginTop: 6 } },
                  (d.tailscaleIp || '') +
                  (d.os ? ' · ' + d.os : '') +
                  (d.detail ? ' · ' + d.detail : '')),
              ),
            ),
      );
    }

    /* ---------------- 注册 ---------------- */

    // 用一个 context 把翻译函数传给子组件，避免层层透传。
    const LocaleCtx = React.createContext(null);

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'super-subagent: dictionaries',
      );
      const t = ctx.locale.bind(NS);

      // Section 需要 t，但 slots.register 传的是组件本身，
      // 所以用 Provider 把 t 注入进去。
      const Bound = () =>
        h(LocaleCtx.Provider, { value: { t } }, h(Section, null));

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'super-subagent',
            order: 17,
            label: () => t('nav'),
            locale: NS,
          },
          Bound,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
