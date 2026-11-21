// 前端半边的加载测试。
//
// 为什么需要它：client.js 跑在浏览器里，语法错误不会被 Node 的
// `--check` 之外的任何东西发现；而它的加载契约是 DSH 私有的
// `window.__ModuleLoader__.load({ id, factory })`，写错一个字段名
// 就表现为"设置页里没有这一项"，控制台也没有明显错误。
//
// 所以这里用一个最小的假环境把模块真的执行一遍：
//   - 假的 window.__ModuleLoader__ 捕获 load 的调用
//   - 假的 react（createElement 返回普通对象树）
//   - 假的 ctx（slots / locale / effect）
// 然后断言：注册了正确的 slot、导出了 apply 和 inject、能渲染出组件。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = join(ROOT, 'lib', 'client.js');

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

console.log('=== 准备假环境 ===');

const src = readFileSync(CLIENT, 'utf8');

// 极简 React：只需要 createElement / useContext / useState / useEffect
// 这些被 client.js 用到的东西。createElement 返回普通对象，便于检查结构。
const fakeReact = {
  createElement: (type, props, ...children) => ({
    __el: true,
    type,
    props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
  }),
  // client.js 用 createContext 把 t() 往下传，避免每个组件都要接一层 props。
  createContext: (defaultValue) => ({
    __ctx: true,
    defaultValue,
    Provider: 'Provider',
    Consumer: 'Consumer',
  }),
  useContext: (ctx) => (ctx && ctx.defaultValue !== undefined ? ctx.defaultValue : null),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  Fragment: 'Fragment',
};

let loaded = null;
const fakeLoader = {
  load: (def) => {
    loaded = def;
  },
};

const slots = [];
const localeRegs = [];
const effects = [];

const fakeCtx = {
  slots: {
    // 真实的 ctx.slots.inject(name, cb) 会在该 slot 存在时执行 cb。
    // 这里直接执行，否则被测代码里被 inject 包住的 register 永远不会跑，
    // 测试就会误报"没注册任何东西"。
    inject: (name, cb) => {
      if (typeof cb === 'function') cb();
      return () => {};
    },
    register: (def, comp) => {
      slots.push({ def, comp });
      return () => {};
    },
  },
  locale: {
    register: (ns, dict) => {
      localeRegs.push({ ns, dict });
      return () => {};
    },
    bind: () => (key) => '[' + key + ']',
  },
  effect: (fn) => {
    // 与 cordis 一致：立即执行，把返回值当清理函数。
    const d = fn();
    effects.push(d);
    return d;
  },
};

const sandbox = {
  window: { __ModuleLoader__: fakeLoader },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('not used in load test')),
  AbortSignal: { timeout: () => null },
  exports: {},
  module: { exports: {} },
};
sandbox.globalThis = sandbox;

console.log('');
console.log('=== 执行 client.js ===');

try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'client.js', timeout: 20000 });
  ok('执行没有抛异常', true);
} catch (e) {
  ok('执行没有抛异常', false, String(e.message).slice(0, 300));
}

ok('调用了 __ModuleLoader__.load', loaded !== null);
if (loaded) {
  ok('load 的 id 是 dsh-super-subagent', loaded.id === 'dsh-super-subagent', String(loaded.id));
  ok('load 提供了 factory', typeof loaded.factory === 'function');

  console.log('');
  console.log('=== 执行 factory ===');

  let mod = null;
  try {
    // DSH 的 factory 签名是 factory(require)，require 用来取 react 等宿主模块
    mod = loaded.factory((name) => {
      if (name === 'react') return fakeReact;
      throw new Error('未知的宿主模块: ' + name);
    });
    ok('factory 执行成功', true);
  } catch (e) {
    ok('factory 执行成功', false, String(e.message).slice(0, 300));
  }

  if (mod) {
    ok('导出了 apply', typeof mod.apply === 'function');
    ok(
      'inject 声明了 slots 和 locale',
      Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'),
      JSON.stringify(mod.inject),
    );

    console.log('');
    console.log('=== 应用（apply）===');
    try {
      mod.apply(fakeCtx);
      ok('apply 执行成功', true);
    } catch (e) {
      ok('apply 执行成功', false, String(e.message).slice(0, 300));
    }

    ok('注册了 locale 字典', localeRegs.length >= 1, JSON.stringify(localeRegs.map((r) => r.ns)));
    // 注意：注册时的命名空间是 'super-subagent'，不含 'zh' 字样。
    // 真正的判据是"传进去的字典里有没有 zh / en 两份，且中文那份含中文"。
    const reg = localeRegs[0];
    ok('字典带 zh 和 en 两份', Boolean(reg && reg.dict && reg.dict.zh && reg.dict.en),
      reg && reg.dict ? Object.keys(reg.dict).join(',') : 'n/a');
    if (reg && reg.dict && reg.dict.zh) {
      const zhKeys = Object.keys(reg.dict.zh);
      ok('中文字典非空', zhKeys.length > 5, zhKeys.length + ' 条');
      ok(
        '中文字典里真的有中文',
        /[\u4e00-\u9fa5]/.test(JSON.stringify(reg.dict.zh)),
      );
      ok(
        '中英字典键一致（漏翻会导致界面出现原始 key）',
        zhKeys.length === Object.keys(reg.dict.en || {}).length,
        zhKeys.length + ' vs ' + Object.keys(reg.dict.en || {}).length,
      );
    }

    ok('往 slots 里注册了东西', slots.length >= 1, slots.length + ' 个');
    if (slots.length) {
      const s = slots[0];
      ok('注册的 slot 是 settings.section', s.def && s.def.name === 'settings.section', String(s.def && s.def.name));
      ok('slot 有 id', Boolean(s.def.id), String(s.def.id));
      ok('slot 有 order（数字）', typeof s.def.order === 'number', String(s.def.order));
      ok('slot 提供了组件', typeof s.comp === 'function');

      console.log('');
      console.log('=== 渲染组件（不需要浏览器）===');
      try {
        // 组件内部会调 useState / useEffect / fetch，这里只要求它能返回
        // 一棵元素树而不抛异常。异步请求会失败，但应该被组件自己 catch 住。
        const tree = s.comp({});
        ok('首次渲染返回了元素树', Boolean(tree && tree.__el), typeof tree);
        if (tree && tree.__el) {
          ok('返回的不是空对象', Object.keys(tree).length >= 2);
        }
      } catch (e) {
        ok('首次渲染返回了元素树', false, String(e.message).slice(0, 300));
      }
    }
  }
}

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
