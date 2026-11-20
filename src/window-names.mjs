// window-names.mjs 窗口命名的三个前缀（T-31：跨插件统一）
//
// 规范见 `magpie-plugins/UNIFIED-PLAN.md` §1.1，全部窗口名只能以这三者之一开头：
//
//	额度 · <名称>   正常参与路由的额度（有 `used`，或 `balance`+`unit`）
//	停用 · <原因>   `used: 100` —— **让路由跳过该号**的唯一手段（规范 §4.4）
//	说明 · <主题>   `aside: true` —— 只解释，不参与路由
//
// ⚠ 分隔符固定 ` · `（空格 + U+00B7 + 空格），不要 `・` / `|` / `-` / `（）`。
// ⚠ 名字里**不写数值**（`· 剩 N` 之类）：`amount`/`limit`/`balance` 已经给了，
//   magpie 自己会算并渲染；名字里再写一遍既重复，又会让窗口在两次刷新之间「改名」。
//
// 本插件（果办 OfficeAce + 码道 CodeArts）**没有任何 `停用 · ` 窗口**：
// 两个上游都没有「这个号不能用了」的证据链，伪造 `used:100` 会把健康的号判死
// （规范 §4.3 第 2 条）。停派只由 `provider.models` 返回空目录承担。

export const QUOTA_PREFIX = "额度 · "
export const STOP_PREFIX = "停用 · "
export const NOTE_PREFIX = "说明 · "

/**
 * 「额度读不到」的说明窗（读取失败专用）。
 *
 * `error` 会**替代整个窗口区**显示（规范 §4.1）—— 一次网络抖动就把整张卡变成一行字。
 * 所以「读不到」也走窗口：`说明` 前缀 + `aside`，卡片上仍是一行，但它是**窗口**，
 * 不是「这个号别的额度都没了」。
 *
 * @param {string} reason 原因（会同时进 name 的括号与 display）
 * @returns {{name: string, aside: true, display: string}}
 */
export function unreadableWindow(reason) {
  const why = String(reason ?? "").trim() || "未知原因"
  return { name: `${NOTE_PREFIX}额度读不到（${why}）`, aside: true, display: why }
}

/**
 * 「额度还没读过」的说明窗（T-39）。
 *
 * `auth.usage` 只读缓存，所以**没有任何缓存**时它只能说「还没读过」——
 * 这不是错误，也不该编数字（编数字比说"不知道"更糟）。
 *
 * @param {string} [display] 怎么读取（各插件入口不同）
 * @returns {{name: string, aside: true, display: string}}
 */
export function usageUnreadWindow(display = "点面板「刷新」读取") {
  return { name: `${NOTE_PREFIX}额度未读`, aside: true, display: String(display) }
}
