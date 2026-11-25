// refresh-guard.mjs — 一次性 refresh_token 失效后的本地冷却
//
// 华为云 STS 的 refresh_token 只能用一次。被消费后再拿它去续期只会得到
// STS5.1806，而插件如果每次请求都重试，日志就被同一条错误刷屏。
//
// 这里把「已被消费」的事实落盘 24 小时（只存 token 的哈希，绝不存 token 本身）：
// 冷却期内 refresh 钩子直接跳过，不再打上游；重新登录后拿到**新的**
// refresh_token 会算出不同的键，自动不受冷却影响。

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export const DEAD_REFRESH_TTL_MS = 24 * 60 * 60 * 1000

/** 只保留哈希前缀：文件泄露也不会暴露任何可用凭据。 */
export function deadRefreshKey(cred) {
  return crypto
    .createHash("sha256")
    .update(String(cred?.refreshToken ?? ""))
    .digest("hex")
    .slice(0, 16)
}

export function makeDeadRefreshGuard({ file = "", now = () => Date.now(), ttlMs = DEAD_REFRESH_TTL_MS } = {}) {
  const target = String(file ?? "").trim()

  function read() {
    if (!target) return {}
    try {
      const raw = JSON.parse(fs.readFileSync(target, "utf8"))
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  }

  function write(data) {
    if (!target) return false
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
      fs.renameSync(tmp, target)
      return true
    } catch {
      return false
    }
  }

  return {
    /** 这个 refresh_token 是否处于冷却期。 */
    isDead(cred) {
      if (!cred?.refreshToken || !target) return false
      const ts = Number(read()[deadRefreshKey(cred)] ?? 0)
      return Number.isFinite(ts) && ts > 0 && now() - ts < ttlMs
    },

    /** 标记它已死（STS5.1806 等明确永久失败才调），到期的键顺手清掉。 */
    markDead(cred) {
      if (!cred?.refreshToken || !target) return false
      const stamp = now()
      const data = read()
      for (const [k, v] of Object.entries(data)) {
        if (!Number.isFinite(Number(v)) || stamp - Number(v) >= ttlMs) delete data[k]
      }
      data[deadRefreshKey(cred)] = stamp
      return write(data)
    },
  }
}
