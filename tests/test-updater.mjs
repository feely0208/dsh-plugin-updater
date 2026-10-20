import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRegistrySpec,
  isNewer,
  collectUpdates,
  runPnpmAdd,
  apply,
} from '../lib/index.js';

function makeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-test',
        dependencies: {
          '@deepwhale-cn/dsh-badge': '^0.1.0',
          '@scope/plain-dep': '^1.0.0',
          'local-plugin': 'link:../local-plugin',
          '@scope/no-bundle': '^0.2.0',
        },
      },
      null,
      2,
    ),
  );
  const write = (name, manifest) => {
    const d = path.join(dir, 'node_modules', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(manifest));
  };
  write('@deepwhale-cn/dsh-badge', {
    name: '@deepwhale-cn/dsh-badge',
    version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  write('@scope/plain-dep', { name: '@scope/plain-dep', version: '1.0.0' });
  write('@scope/no-bundle', { name: '@scope/no-bundle', version: '0.2.0' });
  return dir;
}

test('isRegistrySpec 只认 registry 依赖', () => {
  assert.equal(isRegistrySpec('^0.1.0'), true);
  assert.equal(isRegistrySpec('1.2.3'), true);
  assert.equal(isRegistrySpec('link:../x'), false);
  assert.equal(isRegistrySpec('file:/tmp/a.tgz'), false);
  assert.equal(isRegistrySpec('git+ssh://github.com/a/b.git'), false);
  assert.equal(isRegistrySpec('workspace:*'), false);
});

test('isNewer 比较主版本号', () => {
  assert.equal(isNewer('0.1.1', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
});

test('collectUpdates：只扫第三方 dsh.bundle 插件，并拿到 latest', async () => {
  const dir = makeProfile();
  const fetchImpl = async (url) => {
    assert.match(url, /registry\.npmjs\.org/);
    if (url.includes('dsh-badge')) {
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.1.1' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const rows = await collectUpdates(dir, { fetchImpl });
  assert.equal(rows.length, 1, '只有 dsh-badge 是第三方 dsh 插件');
  assert.equal(rows[0].name, '@deepwhale-cn/dsh-badge');
  assert.equal(rows[0].installed, '0.1.0');
  assert.equal(rows[0].latest, '0.1.1');
  assert.equal(isNewer(rows[0].latest, rows[0].installed), true);
});

test('registry 查询失败时行内带 error，不影响其它行', async () => {
  const dir = makeProfile();
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const rows = await collectUpdates(dir, { fetchImpl });
  assert.equal(rows.length, 1);
  assert.match(rows[0].error, /500/);
});

test('runPnpmAdd 用 --save-exact 精确版本（绕过 pnpm 观察期）', async () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const handlers = {};
    queueMicrotask(() => {
      handlers.stdout?.({ toString: () => 'ok' });
      handlers.close?.(0);
    });
    return {
      stdout: { on: (_e, fn) => (handlers.stdout = fn) },
      stderr: { on: () => {} },
      on: (event, fn) => (handlers[event] = fn),
      kill: () => {},
    };
  };
  const result = await runPnpmAdd('/tmp/profile-x', '@deepwhale-cn/dsh-badge', '0.1.1', { spawnImpl: fakeSpawn });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'add');
  assert.equal(calls[0].args[1], '--save-exact');
  assert.equal(calls[0].args[2], '@deepwhale-cn/dsh-badge@0.1.1');
});

test('apply() 注册 check / apply 两个工具，并能在工具里跑一次检查', async () => {
  const dir = makeProfile();
  const registered = [];
  const ctx = {
    profileContext: { dir },
    tools: { register: (tool) => registered.push(tool) },
  };
  apply(ctx);
  assert.deepEqual(
    registered.map((t) => t.name),
    ['plugin_update_check', 'plugin_update_apply'],
  );
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.1.1' } }) });
  try {
    const text = await registered[0].execute({});
    assert.match(text, /dsh-badge/);
    assert.match(text, /已装 0\.1\.0/);
    assert.match(text, /最新 0\.1\.1/);
    assert.match(text, /1 个可更新/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('apply 工具 dry_run 不执行安装', async () => {
  const dir = makeProfile();
  const registered = [];
  const ctx = { profileContext: { dir }, tools: { register: (tool) => registered.push(tool) } };
  apply(ctx);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.1.1' } }) });
  try {
    const text = await registered[1].execute({ names: ['@deepwhale-cn/dsh-badge'], dry_run: true });
    assert.match(text, /dry run/);
    assert.match(text, /0\.1\.0 → 0\.1\.1/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
