/**
 * `@deepwhale-cn/dsh-plugin-updater`
 *
 * 解决一个真实缺口（2026-10-20 实测）：DSH 官方插件页**只对官方目录里的包**计算更新目标，
 * 第三方 npm 插件装上后没有「更新」按钮，只能卸载重装；而 pnpm 11+ 默认
 * `minimumReleaseAge: 1440`（新发布版本要满 1 天才允许被解析）又会让「装最新版」
 * 在一天内拿不到新版本。
 *
 * 这个插件提供两个模型工具：
 *   - `plugin_update_check`：列出第三方插件「已装版本 / registry 最新版本」
 *   - `plugin_update_apply`：按**精确版本**安装（`pkg@x.y.z`，pnpm 对精确版本直接放行），
 *     不静默更新、必须显式点名或 all=true
 *
 * 安全边界：
 *   - 只处理 profile 里 **npm registry 依赖**（跳过 link: / file: / git / workspace）
 *   - 只处理声明了 `dsh.bundle` 的包（避免误动普通依赖）
 *   - 不做后台自动更新；更新后提示重启（bundle 组合在启动时定型）
 *
 * @module @deepwhale-cn/dsh-plugin-updater
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'plugin-updater';
export const inject = ['tools', 'profileContext', 'webServer'];

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 只认普通 registry 语义的依赖；本地路径/协议依赖不归这个插件管 */
export function isRegistrySpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return false;
  const s = spec.trim();
  if (/^(link:|file:|git:|git\+|workspace:|portal:|https?:|ssh:|github:)/i.test(s)) return false;
  return true;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 读 profile 的依赖表（name → spec） */
export function readProfileDependencies(profileDir) {
  const manifest = readJson(path.join(profileDir, 'package.json'));
  return manifest?.dependencies ?? {};
}

/** 已安装包的版本与 manifest（找不到返回 null） */
export function readInstalledPackage(profileDir, packageName) {
  const manifest = readJson(path.join(profileDir, 'node_modules', packageName, 'package.json'));
  if (manifest === null) return null;
  return { version: manifest.version, dshBundle: manifest.dsh?.bundle !== undefined };
}

/** 从 registry 的 dist-tags.latest 取最新版本 */
export async function fetchLatestVersion(packageName, { registry = DEFAULT_REGISTRY, fetchImpl = fetch } = {}) {
  const url = `${registry.replace(/\/+$/, '')}/${packageName.replace('/', '%2F')}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry ${String(res.status)} for ${packageName}`);
  const body = await res.json();
  const latest = body?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || latest === '') throw new Error(`no dist-tags.latest for ${packageName}`);
  return latest;
}

function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a 是否比 b 新（只比较去掉了预发布后缀的主版本号） */
export function isNewer(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === null || vb === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] > vb[i]) return true;
    if (va[i] < vb[i]) return false;
  }
  return false;
}

/**
 * 扫描 profile 里的第三方插件（纯函数，便于测试）。
 * @returns 行：{ name, installed, latest, spec }
 */
export async function collectUpdates(profileDir, { registry, fetchImpl } = {}) {
  const deps = readProfileDependencies(profileDir);
  const rows = [];
  for (const [packageName, spec] of Object.entries(deps)) {
    if (!isRegistrySpec(spec)) continue;
    const installed = readInstalledPackage(profileDir, packageName);
    if (installed === null || !installed.dshBundle) continue;
    rows.push({ name: packageName, installed: installed.version, latest: null, spec, error: null });
  }
  const concurrency = 8;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        row.latest = await fetchLatestVersion(row.name, { registry, fetchImpl });
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
      }
    }
  });
  await Promise.all(workers);
  return rows;
}

function renderTable(rows) {
  if (rows.length === 0) return '没有扫描到第三方 npm 插件（本地 link/file 依赖与官方随包插件不在管理范围）。';
  const lines = ['第三方插件更新检查：', ''];
  let updatable = 0;
  for (const row of rows) {
    if (row.error !== null) {
      lines.push(`  ⚠️ ${row.name}  已装 ${row.installed ?? '?'}  查询失败：${row.error}`);
      continue;
    }
    const fresh = isNewer(row.latest, row.installed);
    if (fresh) updatable += 1;
    lines.push(`  ${fresh ? '⬆️' : '✅'} ${row.name}  已装 ${row.installed}  最新 ${row.latest}${fresh ? '  （可更新）' : ''}`);
  }
  lines.push('');
  lines.push(`共 ${String(rows.length)} 个第三方插件，${String(updatable)} 个可更新。`);
  if (updatable > 0) {
    lines.push('要更新：调用 plugin_update_apply，names 传包名列表，或 all=true 更新全部。');
  }
  return lines.join('\n');
}

/** 用精确版本安装（绕过 pnpm 新版本观察期） */
export function runPnpmAdd(profileDir, packageName, version, { spawnImpl = spawn, pnpmCommand = 'pnpm', timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const args = ['add', '--save-exact', `${packageName}@${version}`];
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(pnpmCommand, args, { cwd: profileDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, output: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill?.('SIGTERM');
      } catch {
        // 忽略
      }
      finish({ ok: false, output: `${output}\n(超时 ${String(timeoutMs)}ms)` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on?.('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, output: `${output}\n${String(error)}`.trim() });
    });
    child.on?.('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, output: output.trim() });
    });
  });
}

function resolveProfileDir(ctx) {
  const dir = ctx?.profileContext?.dir;
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('profile-updater: 取不到当前 profile 目录（profileContext.dir）');
  }
  return dir;
}

/** 一行「可更新」判定，供工具与 HTTP 路由共用 */
export function withUpdateFlag(row) {
  return {
    ...row,
    updateAvailable: row.error === null && row.latest !== null && isNewer(row.latest, row.installed),
  };
}

/** 检查结果（工具与网页共用）：带 updateAvailable 的行 */
export async function readUpdates(profileDir) {
  const rows = await collectUpdates(profileDir);
  return rows.map(withUpdateFlag);
}

/**
 * 执行更新（工具与网页共用）。
 * @param {{ names?: string[], all?: boolean, dryRun?: boolean }} options
 * @returns {{ targets: object[], results: object[], skipped: string }}
 */
export async function performUpdates(profileDir, options = {}) {
  const rows = await readUpdates(profileDir);
  const wanted = Array.isArray(options.names) ? options.names : [];
  const targets = rows.filter((row) => row.updateAvailable && (options.all === true || wanted.includes(row.name)));
  if (targets.length === 0) {
    return { targets: [], results: [], skipped: wanted.length > 0 ? `没有可更新的目标：${wanted.join(', ')}` : '没有可更新的插件。' };
  }
  if (options.dryRun === true) return { targets, results: [], skipped: 'dry run（未安装）' };
  const results = [];
  for (const target of targets) {
    const out = await runPnpmAdd(profileDir, target.name, target.latest);
    results.push({ name: target.name, from: target.installed, to: target.latest, ok: out.ok, output: out.output });
  }
  return { targets, results, skipped: '' };
}

/** 注册两个工具 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'plugin_update_check',
    description:
      '检查当前 DSH profile 里第三方 npm 插件是否有新版本：对比已装版本与 registry dist-tags.latest，列出可更新项。用于回答「我的插件有新版本吗」。',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      const profileDir = resolveProfileDir(ctx);
      const rows = await readUpdates(profileDir);
      return renderTable(rows);
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: '检查插件更新' }),
  }));

  ctx.tools.register(defineTool({
    name: 'plugin_update_apply',
    description:
      '把指定第三方 DSH 插件更新到 registry 最新版本（按精确版本安装，绕过 pnpm 新版本观察期）。必须显式给 names 或 all=true；更新后需要重启桌面端/DSH 才生效。',
    parameters: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: '要更新的包名列表，例如 ["@deepwhale-cn/dsh-badge"]。',
      },
      all: {
        type: 'boolean',
        description: '为 true 时更新所有可更新的第三方插件。',
      },
      dry_run: {
        type: 'boolean',
        description: '为 true 时只列出将要执行的操作，不实际安装。',
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 600_000,
    execute: async (args) => {
      const profileDir = resolveProfileDir(ctx);
      const { targets, results, skipped } = await performUpdates(profileDir, {
        names: args?.names,
        all: args?.all === true,
        dryRun: args?.dry_run === true,
      });
      if (results.length === 0) {
        if (args?.dry_run === true) {
          return ['将执行（dry run，未安装）：', ...targets.map((t) => `  ${t.name}: ${t.installed} → ${t.latest}`)].join('\n');
        }
        return skipped;
      }
      const lines = ['插件更新结果：', ''];
      for (const r of results) {
        lines.push(`  ${r.ok ? '✅' : '❌'} ${r.name}: ${r.from} → ${r.to}`);
        if (!r.ok) lines.push(`      ${r.output.split('\n').slice(-3).join('\n      ')}`);
      }
      const okCount = results.filter((r) => r.ok).length;
      lines.push('');
      lines.push(`${String(okCount)}/${String(results.length)} 成功。`);
      if (okCount > 0) lines.push('重启桌面端（或 DSH 服务）后新版本才会加载 —— bundle 组合在启动时定型。');
      return lines.join('\n');
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'write',
      title: '更新插件',
      rawInput: args?.all === true ? '全部' : (args?.names ?? []).join(', '),
    }),
  }));

  // ── 浏览器半边（lib/client.js）用的 HTTP 路由 ──
  const sendJson = (res, status, value) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const readJsonBody = async (req) => {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 64 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-updater/check',
    handler: async (_req, res) => {
      try {
        const rows = await readUpdates(resolveProfileDir(ctx));
        sendJson(res, 200, { ok: true, rows });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-updater/apply',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const outcome = await performUpdates(resolveProfileDir(ctx), {
          names: Array.isArray(body.names) ? body.names : undefined,
          all: body.all === true,
          dryRun: body.dryRun === true,
        });
        sendJson(res, 200, { ok: true, ...outcome });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }));
}
