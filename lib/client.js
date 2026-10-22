/**
 * @deepwhale-cn/dsh-plugin-updater —— 浏览器半边
 *
 * 0.3.0：**有意不再渲染任何界面**。
 *
 * 历史教训（2026-10-22）：这里曾经有一个"插件更新"悬浮按钮 ——
 *  ① 它靠扫描页面正文关键词判断"是不是插件页"，用户会话里聊到"插件管理/可更新"
 *     就被误判，悬浮条出现在会话页；
 *  ② × 只做了"收起面板"，按钮故意留着，用户怎么点都关不掉。
 * 结论：**插件更新是低频动作，不该常驻任何界面**。
 * 更新能力保留在宿主侧（plugin_update_check / plugin_update_apply 两个工具），
 * 需要时说一句"检查/更新插件"即可。
 */
window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-plugin-updater',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    exports.inject = [];
    exports.apply = function apply() {};
    return module.exports;
  },
});
