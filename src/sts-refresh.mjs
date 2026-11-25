// sts-refresh.mjs — 读额度前把过期的 STS 临时凭据续一次
//
// T-41 把 magpie 的 `expires` 写成会话 JWT 期限（约 27 天），避免频繁续期；
// 但签名接口用的是 STS AK/SK/securityToken，只有约 1 小时寿命。结果额度
// 查询拿过期 STS 去签名，OfficeAce 得 IAM 401、CodeArts 被吞成空结果。
//
// 这里在「读额度之前」单独判断 STS 是否过期，过期才续一次，并把新凭据
// 原子写回 plugin-auth.json（一次性 refresh_token 必须落盘，否则下次就废了）。

import fs from "node:fs"
import path from "node:path"
import { refreshOnce } from "./login.mjs"
import { expiryMs, stsNeedsRefresh } from "./credential.mjs"
import { officeAceAuthFile } from "./accounts.mjs"

function parseMaybeJson(text) {
  try {
    const v = JSON.parse(String(text ?? ""))
    return v && typeof v === "object" && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** 把续期结果写回 magpie 的账号条目（只碰华为插件的键）。 */
export function persistRefreshedAuth({ authFile, oldRefresh, next }) {
  const target = String(authFile ?? officeAceAuthFile())
  if (!oldRefresh || !next || !target) return false
  let all
  try {
    all = JSON.parse(fs.readFileSync(target, "utf8"))
  } catch {
    return false
  }
  if (!all || typeof all !== "object" || Array.isArray(all)) return false

  const key = Object.keys(all).find(
    (k) =>
      (k.startsWith("officeace") || k.startsWith("codearts")) &&
      (all[k]?.refresh === oldRefresh || parseMaybeJson(all[k]?.access)?.refreshToken === oldRefresh),
  )
  if (!key) return false

  const entry = all[key]
  const merged = { ...(parseMaybeJson(entry.access) ?? {}), ...next }
  entry.access = JSON.stringify(merged)
  if (next.refreshToken) entry.refresh = next.refreshToken
  entry.expires = expiryMs(next)

  try {
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

/**
 * 造一个「STS 过期就续一次」的前置钩子。
 *
 * @param {{authFile?: string, guard?: any, now?: () => number,
 *   refresh?: (cred: any, persist?: (n: any) => void) => Promise<any>}} [opts]
 */
export function makeStsFresh({
  authFile,
  guard,
  now = () => Date.now(),
  refresh = refreshOnce,
} = {}) {
  const target = String(authFile ?? officeAceAuthFile())

  return async function ensureFreshSts(cred) {
    if (!cred?.refreshToken || !stsNeedsRefresh(cred, now())) return cred
    if (guard?.isDead?.(cred)) return cred
    const oldRefresh = cred.refreshToken
    try {
      const next = await refresh(cred, (n) => persistRefreshedAuth({ authFile: target, oldRefresh, next: n }))
      return next ?? cred
    } catch (e) {
      if (e?.deadRefresh) guard?.markDead?.(cred)
      return cred
    }
  }
}
