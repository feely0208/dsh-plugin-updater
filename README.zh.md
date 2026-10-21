# @deepwhale-cn/dsh-plugin-updater

检查并更新**第三方 DSH 插件**，补上官方插件页没有的那块：

- 官方插件页只对**官方目录**里的包计算更新目标 → 第三方 npm 插件装上后没有「更新」按钮
- pnpm 11+ 默认 `minimumReleaseAge: 1440`（新发布版本要满 1 天）→ 卸载重装也拿不到刚发的版本

这个插件用**精确版本安装**（`pkg@x.y.z`）绕过观察期，一条命令完成升级。

## 安装

```sh
dsh plugin --profile <你的 profile> add @deepwhale-cn/dsh-plugin-updater
```

## 提供的工具

| 工具 | 作用 |
|---|---|
| `plugin_update_check` | 列出第三方插件「已装版本 / registry 最新版本」，标出可更新项 |
| `plugin_update_apply` | 按 `names`（包名列表）或 `all=true` 精确升级；支持 `dry_run` 预览 |

对模型说「检查插件更新」「把 dsh-badge 更新一下」就会用到它们。

## 安全边界

- 只处理 profile 里 **npm registry 依赖**：`link:` / `file:` / `git:` / `workspace:` 一律跳过
- 只处理声明了 `dsh.bundle` 的包，避免误动普通依赖
- **不做后台自动更新**，必须显式点名或 `all=true`
- 更新后需要**重启桌面端 / DSH 服务**（bundle 组合在启动时定型）

## 示例输出

```
第三方插件更新检查：

  ⬆️ @deepwhale-cn/dsh-badge  已装 0.1.0  最新 0.1.1  （可更新）

共 1 个第三方插件，1 个可更新。
```

## License

MIT © 温州深鲸智能科技有限公司

## 0.2.2：界面一键更新（插件页右下角常驻）

装好重启后，**只在「插件」页面、且确实有更新时**，右下角会出现「⚡ 插件更新」按钮（角标显示可更新数量）：

- 点开 → 列出第三方插件「已装 → 最新」
- 单个「更新」或「全部更新」，按精确版本安装（`--save-exact`）
- 更新完成提示重启，重启后新版本生效
- 按钮可**拖动**；点「×」只收起面板，入口不会消失（插件页右下角一直在）

界面通过同源 HTTP 路由（`/plugin-updater/check`、`/plugin-updater/apply`）调用本插件的宿主半边，安装判据与动作仍在宿主侧。
