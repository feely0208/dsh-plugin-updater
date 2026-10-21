/**
 * @deepwhale-cn/dsh-plugin-updater —— 浏览器半边（客户端插件）
 *
 * 为什么存在：DSH 官方插件页只对「官方目录」里的包计算更新目标，第三方 npm 插件
 * 装上后**没有更新按钮**，只能卸载重装；而 pnpm 11+ 的新版本观察期又让「重装取最新」
 * 在一天内拿不到刚发布的版本。宿主半边已经能精确升级（lib/index.js 的 HTTP 路由），
 * 这里只负责把它做成界面上点得动的按钮。
 *
 * 边界：
 *   - 只请求同源的 /plugin-updater/check 与 /plugin-updater/apply
 *   - 只做 UI + 网络调用，不做安装逻辑（判据和动作都在宿主侧）
 *   - 不读官方 DOM 结构，做成独立浮层，官方改版也不受影响
 */
window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-plugin-updater',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    /** 不需要注入客户端服务：所有动作都走同源 HTTP 路由。 */
    const inject = [];

    const CSS = `
.dwh-upd-btn{position:fixed;right:24px;bottom:104px;z-index:2147482800;display:none;align-items:center;gap:8px;
  background:#0e2745;color:#dff2ff;border:1px solid rgba(120,200,255,.35);border-radius:999px;
  padding:10px 16px;font:600 13.5px/1 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  cursor:pointer;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.dwh-upd-btn.on{display:flex}
.dwh-upd-btn:hover{background:#143a63}
.dwh-upd-btn .close{background:none;border:0;color:#8fb0cc;font-size:15px;line-height:1;cursor:pointer;padding:0 2px}
.dwh-upd-btn .close:hover{color:#fff}
.dwh-upd-btn .n{display:none;min-width:18px;height:18px;border-radius:9px;background:#2dd4bf;color:#04222b;
  font-size:11.5px;line-height:18px;text-align:center;padding:0 5px}
.dwh-upd-btn.has .n{display:inline-block}
.dwh-upd-panel{position:fixed;right:24px;bottom:156px;z-index:2147482801;width:400px;max-width:calc(100vw - 32px);
  max-height:70vh;display:none;flex-direction:column;background:#08192e;color:#e7f1ff;
  border:1px solid rgba(120,200,255,.28);border-radius:16px;overflow:hidden;
  box-shadow:0 18px 60px rgba(0,0,0,.55);font:13.5px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.dwh-upd-panel.open{display:flex}
.dwh-upd-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;
  border-bottom:1px solid rgba(120,200,255,.14);font-weight:700}
.dwh-upd-hd small{color:#8fb0cc;font-weight:400;font-size:12px}
.dwh-upd-hd .x{background:none;border:0;color:#8fb0cc;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px}
.dwh-upd-bd{overflow:auto;padding:8px 10px 12px}
.dwh-upd-row{display:flex;align-items:center;gap:10px;padding:10px 8px;border-radius:10px}
.dwh-upd-row:hover{background:rgba(60,140,220,.10)}
.dwh-upd-name{flex:1;min-width:0}
.dwh-upd-name b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwh-upd-name span{color:#8fb0cc;font-size:12px}
.dwh-upd-go{flex:none;background:#2dd4bf;color:#04222b;border:0;border-radius:8px;padding:7px 12px;
  font-weight:700;font-size:12.5px;cursor:pointer}
.dwh-upd-go:disabled{opacity:.5;cursor:default}
.dwh-upd-all{margin:6px 8px 10px;width:calc(100% - 16px);background:#143a63;color:#dff2ff;
  border:1px solid rgba(120,200,255,.28);border-radius:10px;padding:9px;font-weight:600;cursor:pointer}
.dwh-upd-empty{color:#8fb0cc;padding:18px 10px;text-align:center}
.dwh-upd-msg{margin:6px 8px;padding:9px 10px;border-radius:9px;font-size:12.5px;display:none;white-space:pre-wrap}
.dwh-upd-msg.err{display:block;background:rgba(255,90,90,.12);color:#ffb4b4;border:1px solid rgba(255,90,90,.3)}
.dwh-upd-msg.ok{display:block;background:rgba(45,212,191,.12);color:#8ff0df;border:1px solid rgba(45,212,191,.3)}
.dwh-upd-ft{padding:9px 16px 12px;border-top:1px solid rgba(120,200,255,.12);color:#7f9ab8;font-size:11.5px}
`;

    const CHECK_URL = '/plugin-updater/check';
    const APPLY_URL = '/plugin-updater/apply';

    function withToken(url) {
      // 桌面端用 ?token= 认证时会话在 URL 上；同源 fetch 带上同一个 token。
      try {
        const token = new URLSearchParams(window.location.search).get('token');
        if (!token) return url;
        return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      } catch {
        return url;
      }
    }

    async function getJson(url) {
      const res = await fetch(withToken(url), { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${String(res.status)}`);
      return body;
    }

    function apply() {
      if (window.__deepwhaleUpdaterMounted) return;
      window.__deepwhaleUpdaterMounted = true;

      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      const btn = document.createElement('button');
      btn.className = 'dwh-upd-btn';
      btn.type = 'button';
      btn.innerHTML = '<span>⚡</span><span>插件更新</span><span class="n">0</span><button class="close" type="button" title="不再提示（有新版本时再出现）">×</button>';

      const panel = document.createElement('div');
      panel.className = 'dwh-upd-panel';
      panel.innerHTML = `
        <div class="dwh-upd-hd"><div>插件更新 <small>第三方 npm 插件</small></div><button class="x" type="button" title="关闭">×</button></div>
        <div class="dwh-upd-bd"></div>
        <div class="dwh-upd-ft">按精确版本安装（绕过 pnpm 新版本观察期）；更新后重启桌面端生效。</div>`;

      const body = panel.querySelector('.dwh-upd-bd');
      const badge = btn.querySelector('.n');
      const closeBtn = btn.querySelector('.close');
      let rows = [];
      let busy = false;
      let dismissedKey = null;
      try {
        dismissedKey = window.localStorage.getItem('dsh-updater-dismissed');
      } catch {
        dismissedKey = null;
      }

      // 只在「插件」页面出现：官方插件页（设置 → 插件 / 详情页）有这些固定文案。
      function onPluginsPage() {
        const text = document.body && document.body.textContent ? document.body.textContent : '';
        if (!text) return false;
        return text.includes('来源信息') || text.includes('包含的组件') || text.includes('已安装的插件')
          || text.includes('插件管理') || text.includes('可更新') || text.includes('去插件市场');
      }

      function updatesKey() {
        return rows.filter((r) => !r.done).map((r) => `${r.name}@${r.latest}`).sort().join('|');
      }

      function syncVisibility() {
        const hasUpdates = rows.some((r) => !r.done);
        // 插件页常驻入口：关闭只收起面板，不再让按钮消失（否则就找不回来了）。
        const visible = onPluginsPage();
        btn.classList.toggle('on', visible);
        btn.classList.toggle('has', hasUpdates);
        badge.textContent = String(rows.filter((r) => !r.done).length);
        if (!visible) panel.classList.remove('open');
      }

      const msg = document.createElement('div');
      msg.className = 'dwh-upd-msg';

      function setMsg(text, kind) {
        msg.className = `dwh-upd-msg ${kind}`;
        msg.textContent = text;
      }

      function render() {
        body.innerHTML = '';
        if (msg.textContent) body.appendChild(msg);
        if (rows.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dwh-upd-empty';
          empty.textContent = '没有可更新的插件（或还没检查）。';
          body.appendChild(empty);
          badge.textContent = '0';
          btn.classList.remove('has');
          return;
        }
        for (const row of rows) {
          const item = document.createElement('div');
          item.className = 'dwh-upd-row';
          const name = document.createElement('div');
          name.className = 'dwh-upd-name';
          const b = document.createElement('b');
          b.textContent = row.name;
          const span = document.createElement('span');
          span.textContent = `已装 ${row.installed} → 最新 ${row.latest}`;
          name.append(b, span);
          const go = document.createElement('button');
          go.className = 'dwh-upd-go';
          go.type = 'button';
          go.textContent = row.done ? '已更新' : '更新';
          go.disabled = busy || row.done === true;
          go.addEventListener('click', () => applyOne(row.name));
          item.append(name, go);
          body.appendChild(item);
        }
        const all = document.createElement('button');
        all.className = 'dwh-upd-all';
        all.type = 'button';
        all.textContent = busy ? '更新中…' : `全部更新（${String(rows.filter((r) => !r.done).length)} 个）`;
        all.disabled = busy || rows.every((r) => r.done);
        all.addEventListener('click', () => applyMany(rows.filter((r) => !r.done).map((r) => r.name)));
        body.appendChild(all);
        syncVisibility();
      }

      async function check() {
        try {
          const result = await getJson(CHECK_URL);
          rows = (result.rows ?? []).filter((row) => row.updateAvailable === true);
          setMsg('', '');
        } catch (error) {
          setMsg(`检查失败：${error instanceof Error ? error.message : String(error)}`, 'err');
        }
        render();
      }

      async function applyMany(names) {
        if (busy || names.length === 0) return;
        busy = true;
        setMsg('', '');
        render();
        try {
          const res = await fetch(withToken(APPLY_URL), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ names }),
          });
          const bodyJson = await res.json().catch(() => ({}));
          if (!res.ok || bodyJson.ok === false) throw new Error(bodyJson.error || `HTTP ${String(res.status)}`);
          const ok = (bodyJson.results ?? []).filter((r) => r.ok).length;
          const total = (bodyJson.results ?? []).length;
          const failed = (bodyJson.results ?? []).filter((r) => !r.ok);
          for (const r of bodyJson.results ?? []) {
            const row = rows.find((x) => x.name === r.name);
            if (row && r.ok) row.done = true;
          }
          if (failed.length > 0) {
            setMsg(`${String(ok)}/${String(total)} 成功，失败：${failed.map((f) => f.name).join(', ')}`, 'err');
          } else {
            setMsg(`${String(ok)}/${String(total)} 已更新，重启桌面端后生效。`, 'ok');
          }
        } catch (error) {
          setMsg(`更新失败：${error instanceof Error ? error.message : String(error)}`, 'err');
        }
        busy = false;
        render();
      }

      function applyOne(name) {
        void applyMany([name]);
      }

      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        // 只收起面板；入口按钮保留在插件页右下角。
        panel.classList.remove('open');
        setMsg('', '');
      });

      // 拖动：按钮跟面板一起移动，位置记在 localStorage
      try {
        const saved = JSON.parse(window.localStorage.getItem('dsh-updater-pos') || 'null');
        if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
          btn.style.left = `${String(saved.x)}px`;
          btn.style.top = `${String(saved.y)}px`;
          btn.style.right = 'auto';
          btn.style.bottom = 'auto';
        }
      } catch {
        // 忽略
      }
      let dragging = false;
      let dragMoved = false;
      let dragStart = null;
      btn.addEventListener('pointerdown', (event) => {
        if (event.target === closeBtn) return;
        dragging = true;
        dragMoved = false;
        dragStart = { x: event.clientX, y: event.clientY, rect: btn.getBoundingClientRect() };
      });
      window.addEventListener('pointermove', (event) => {
        if (!dragging || dragStart === null) return;
        const dx = event.clientX - dragStart.x;
        const dy = event.clientY - dragStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
        if (!dragMoved) return;
        const x = Math.max(8, Math.min(window.innerWidth - btn.offsetWidth - 8, dragStart.rect.left + dx));
        const y = Math.max(8, Math.min(window.innerHeight - btn.offsetHeight - 8, dragStart.rect.top + dy));
        btn.style.left = `${String(Math.round(x))}px`;
        btn.style.top = `${String(Math.round(y))}px`;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        placePanel();
      });
      window.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        if (dragMoved) {
          try {
            const r = btn.getBoundingClientRect();
            window.localStorage.setItem('dsh-updater-pos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
          } catch {
            // 忽略
          }
        }
      });
      btn.addEventListener('click', (event) => {
        if (dragMoved || event.target === closeBtn) {
          dragMoved = false;
          return;
        }
        const open = panel.classList.toggle('open');
        if (open) {
          setMsg('', '');
          void check();
        }
      });
      panel.querySelector('.x').addEventListener('click', () => panel.classList.remove('open'));

      function placePanel() {
        const r = btn.getBoundingClientRect();
        const panelW = 400;
        const right = Math.max(8, window.innerWidth - Math.min(window.innerWidth - 8, r.right));
        panel.style.right = `${String(Math.round(right))}px`;
        panel.style.left = 'auto';
        panel.style.bottom = `${String(Math.round(window.innerHeight - r.top + 8))}px`;
        if (r.right - panelW < 8) panel.style.width = `${String(Math.min(panelW, r.right - 16))}px`;
      }

      // 页面切换（SPA）+ 插件变化时重新判断要不要显示
      let scanTimer = null;
      const scheduleSync = () => {
        if (scanTimer !== null) return;
        scanTimer = window.setTimeout(() => {
          scanTimer = null;
          syncVisibility();
        }, 400);
      };
      new MutationObserver(scheduleSync).observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener('popstate', scheduleSync);
      window.setInterval(scheduleSync, 2000);

      document.body.append(btn, panel);
      placePanel();
      // 启动后静默检查一次，只为拿角标数字；失败不打扰（例如后端没起来）。
      void check();
      window.setInterval(() => { if (!busy) void check(); }, 300000);
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
