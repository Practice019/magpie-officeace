// token-life.mjs 令牌生命周期：**按「总有效期的 50%」判断该不该续期**（T-41）。
//
// # 用户口径（这是唯一判据）
//
//	「把我们现在所有的插件的续期修改成：还有一半的时间就过期了，那就续期。
//	  我们按百分比来算……按百分比 50% 时间来计算」
//
// 于是：`剩余时间 <= 总有效期 × 0.5` 才续，否则**一个请求都不发**。
//
// # 为什么需要 `iat`
//
// `expires` 只有一个时间点，算不出「一半」；必须有**签发时间**才有总长。JWT 形态的
// token 自带 `iat` / `exp`（base64url 解第二段，**不校验签名** —— 我们只用它算比例，
// 校验是上游的事）。
//
// # 兜底（数据不可信时）
//
//	① 有 iat/exp、total > 0  → 严格 50%
//	② 只有 exp、没有 iat     → `min(6 小时, 剩余)` 的固定窗口（= 老口径的保守版）
//	③ 连 exp 都算不出         → 1 小时固定窗口
//
// ⚠ 兜底只在"数据确实拿不到"时生效；拿到 iat 就必须按 50% 走，不许悄悄退回固定窗口。

/** 兜底窗口上限（没有 iat 时最多提前这么久续）。 */
export const FALLBACK_WINDOW_MS = 6 * 60 * 60 * 1000

/** 连 exp 都算不出时的固定窗口。 */
export const BLIND_WINDOW_MS = 60 * 60 * 1000

/**
 * 解一个 JWT 的 `iat` / `exp`（秒）。**不校验签名**。
 *
 * @param {string} token JWT（`a.b.c`）
 * @returns {{iat: number, exp: number}|null} 解不出 / 不是 JWT / 缺字段 → null
 */
export function readJwtClaims(token) {
  const raw = String(token ?? "").trim()
  if (!raw) return null
  const parts = raw.split(".")
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    const iat = Number(payload?.iat)
    const exp = Number(payload?.exp)
    if (!Number.isFinite(iat) || !Number.isFinite(exp) || iat <= 0 || exp <= 0) return null
    return { iat, exp }
  } catch {
    return null
  }
}

/**
 * 是不是已经走完一半有效期（或已过期）——**T-41 的唯一续期判据**。
 *
 * @param {number} iatSec 签发时间（秒）
 * @param {number} expSec 过期时间（秒）
 * @param {number} [nowSec] 现在（秒）
 * @returns {boolean} true = 该续了
 */
export function pastHalfLife(iatSec, expSec, nowSec = Math.floor(Date.now() / 1000)) {
  const iat = Number(iatSec)
  const exp = Number(expSec)
  const now = Number(nowSec)
  if (!Number.isFinite(exp) || !Number.isFinite(now)) return true // 数据不可信 ⇒ 交给兜底
  if (exp <= now) return true // 已过期
  const total = exp - iat
  if (!Number.isFinite(total) || total <= 0) return true // iat 不可信 ⇒ 交给兜底
  return exp - now <= total * 0.5
}

/**
 * 距离「走到一半」还有多少毫秒（负数/0 = 已经过半或过期）。
 *
 * 只用于**证据/日志**（"还需多久到 50%"），续期判断仍然走 {@link pastHalfLife}。
 *
 * @param {number} iatSec
 * @param {number} expSec
 * @param {number} [nowSec]
 * @returns {number|null} null = 算不出
 */
export function msUntilHalfLife(iatSec, expSec, nowSec = Math.floor(Date.now() / 1000)) {
  const iat = Number(iatSec)
  const exp = Number(expSec)
  const now = Number(nowSec)
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || !Number.isFinite(now)) return null
  const total = exp - iat
  if (!Number.isFinite(total) || total <= 0) return null
  const dueAt = iat + total * 0.5
  return Math.round((dueAt - now) * 1000)
}

/**
 * 兜底判据：没拿到 iat 时用固定窗口（`min(6 小时, 剩余的一小段)`）。
 *
 * @param {number} expiresAtMs 过期时间（毫秒）
 * @param {{nowMs?: number, windowMs?: number}} [opts]
 * @returns {boolean} true = 该续了
 */
export function pastFallbackWindow(expiresAtMs, { nowMs = Date.now(), windowMs = FALLBACK_WINDOW_MS } = {}) {
  const exp = Number(expiresAtMs)
  if (!Number.isFinite(exp)) return true
  return exp - nowMs <= Math.min(windowMs, FALLBACK_WINDOW_MS)
}
