// t41-refresh.test.mjs（T-41 / T-42）续期判据 = **总有效期的 50%**。
//
// 用户口径：
//
//	「把我们现在所有的插件的续期修改成：还有一半的时间就过期了，那就续期。
//	  我们按百分比来算……按百分比 50% 时间来计算」
//
// 三个 provider 共用的规则：
//
//	① 会话 JWT 的 iat/exp 算得出「一半」→ 剩余 <= 总长×0.5 才续，否则**零请求**
//	② 算不出（没有 JWT / 缺字段）→ 照旧续（老凭据兜底）
//	③ magpie 的 `refreshLead` **保持不变**（officeace 10 分钟 / codearts 30 分钟）：
//	   它只负责「临期来问」，真正的闸门在插件内部

import test from "node:test"
import assert from "node:assert/strict"
import { generateDpopKeyPair } from "../src/crypto.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { OfficeAceAuthPlugin, OFFICEACE_OPTIONS, _internal as oa } from "../index.mjs"
import { CodeArtsAuthPlugin, _internal as ca } from "../src/codearts/index.mjs"
import { pastHalfLife, readJwtClaims, msUntilHalfLife } from "../src/token-life.mjs"
import { expiryMs } from "../src/credential.mjs"
import { EXPIRY_LEAD_MS, TOKEN_URL } from "../src/constants.mjs"

process.env.MAGPIE_OFFICEACE_NO_TRIAL_CLAIM = "1"
process.env.MAGPIE_OFFICEACE_NO_BROWSER = "1"
process.env.OFFICEACE_USER_DATA_ROOT = path.join(os.tmpdir(), "officeace-t41-no-client")

const TEMP_DIRS = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "officeace-t41-"))
  TEMP_DIRS.push(dir)
  return dir
}
test.after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true })
})

/** 造一个 JWT（不签名，只用 iat/exp）。 */
function jwt(iat, exp, extra = {}) {
  const h = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const p = Buffer.from(JSON.stringify({ iat, exp, ...extra })).toString("base64url")
  return `${h}.${p}.sig`
}

const NOW = Math.floor(Date.now() / 1000)
const DAY = 86_400

// ── 1) 半程前 false ─────────────────────────────────────────────────────
test("T41-1) 剩 3601 秒 > 一半（3600）→ 不该续", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 3599), false)
})

// ── 2) 过半 true ────────────────────────────────────────────────────────
test("T41-2) 剩 3599 秒 <= 一半 → 该续", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 3601), true)
})

// ── 3) 已过期 ───────────────────────────────────────────────────────────
test("T41-3) 已过期 / 数据坏（total<=0）→ 该续（交给兜底）", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 7201), true)
  assert.equal(pastHalfLife(iat, iat, iat + 100), true, "total<=0")
  assert.equal(pastHalfLife(NaN, iat + 7200, iat), true, "iat 不可信")
})

// ── 4) expires 必须写成会话期限（jwt.exp × 1000）─────────────────────────
test("T41-4) officeace expires = jwt.exp×1000（不是 STS 的 ~1 小时）", () => {
  const iat = NOW
  const exp = NOW + 27 * DAY
  const cred = {
    access: "AK",
    secret: "SK",
    securityToken: "ST",
    // STS 只有 1 小时 —— 绝不能被写进 expires
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshToken: jwt(iat, exp, { user_profile: JSON.stringify({ principal_urn: "iam::d:user:hw1" }) }),
  }
  assert.equal(expiryMs(cred), exp * 1000, "写的是会话期限")
  const written = oa.toStored(cred).expires
  assert.equal(written, exp * 1000)
  assert.ok(Math.abs(written - exp * 1000) < 1, "与 jwt.exp 差 < 1 秒")
})

// ── 5) refreshLead 保持 10 分钟；trialbit 默认 true ──────────────────────
test("T41-5) officeace refreshLead = 10 分钟常量（不改成 0），trialbit 默认 true", async () => {
  const plugin = await OfficeAceAuthPlugin({}, {})
  assert.equal(plugin.auth.refreshLead, EXPIRY_LEAD_MS)
  assert.equal(plugin.auth.refreshLead, 10 * 60 * 1000)
  assert.equal(OFFICEACE_OPTIONS.find((o) => o.key === "trialbit").default, true)
})

// ── 6) officeace：未过半零请求，过半才续 ────────────────────────────────
test("T41-6) officeace refresh：没过半 ⇒ undefined（零请求）；过半 ⇒ 真续", async (t) => {
  const net = { calls: 0 }
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === TOKEN_URL) {
      net.calls += 1
      return Response.json({
        credentials: {
          access_key_id: "new-ak",
          secret_access_key: "new-sk",
          security_token: "new-st",
          expiration: new Date(Date.now() + 3600_000).toISOString(),
        },
        // 续期后的会话 JWT 也已经过半，方便断言
        refresh_token: jwt(NOW - 30 * DAY, NOW + 1 * DAY),
      })
    }
    return new Response("{}", { status: 404 })
  })

  const key = await generateDpopKeyPair()
  const base = { access: "AK", secret: "SK", securityToken: "ST", expiresAt: new Date(Date.now() + 3600_000).toISOString(), dpopPrivateJwk: key.privateJwk, codeVerifier: "t41-verifier", oauth_client: "codearts-agent" }
  const plugin = await OfficeAceAuthPlugin({}, {})
  const recordOf = (cred) => ({ type: "oauth", access: JSON.stringify(cred), refresh: cred.refreshToken, expires: expiryMs(cred) })

  // ① 刚签发（27 天有效期，现在才过 1 天）：零请求
  const fresh = { ...base, refreshToken: jwt(NOW - DAY, NOW + 26 * DAY) }
  assert.equal(await plugin.auth.refresh(recordOf(fresh), {}), undefined)
  assert.equal(net.calls, 0, "没过半 ⇒ 一个请求都不发")

  // ② 已过半（27 天有效期，现在过了 20 天）：真续 1 次
  const past = { ...base, refreshToken: jwt(NOW - 20 * DAY, NOW + 7 * DAY) }
  const next = await plugin.auth.refresh(recordOf(past), {})
  assert.ok(next, "过半 ⇒ 必须续")
  assert.equal(net.calls, 1)
  assert.equal(JSON.parse(next.access).access, "new-ak")
})

// ── 7) codearts：REFRESH_LEAD_MS 非 0；未过半零请求，过半才续 ─────────────
test("T41-7) codearts refreshLead 非 0；没过半 ⇒ 零请求；过半 ⇒ 真续", async (t) => {
  const lead = ca.REFRESH_LEAD_MS ?? 30 * 60 * 1000
  assert.notEqual(lead, 0, "REFRESH_LEAD_MS 不许是 0（T-40 改错的值已恢复）")

  let calls = 0
  t.mock.method(globalThis, "fetch", async (url) => {
    calls += 1
    assert.equal(String(url), ca.STS_TOKEN_ENDPOINT)
    return Response.json({
      credentials: { access_key_id: "AK2", secret_access_key: "SK2", security_token: "ST2", expiration: "2031-01-01T00:00:00Z" },
      refresh_token: "R2",
    })
  })
  const key = await ca.generateDpopKeyPair()
  const plugin = await CodeArtsAuthPlugin({ client: {} }, {})
  const cred = (token) => ({
    access_key_id: "AK",
    security_token: "ST",
    secret_access_key: "SK",
    dpop_private_key_jwk: key.privateKeyJwk,
    code_verifier: "t41-verifier",
    codeVerifier: "t41-verifier",
    oauth_client: "codearts-agent",
    refresh_token: token,
  })
  const recordOf = (c) => ({ type: "oauth", access: JSON.stringify(c), refresh: c.refresh_token, expires: ca.expiresFromCredential(c) })

  // ① 刚签发：零请求
  const fresh = cred(jwt(NOW - DAY, NOW + 26 * DAY))
  assert.equal(await plugin.auth.refresh(recordOf(fresh)), undefined)
  assert.equal(calls, 0, "没过半 ⇒ 零请求")

  // ② 已过半：真续
  const past = cred(jwt(NOW - 20 * DAY, NOW + 7 * DAY))
  const next = await plugin.auth.refresh(recordOf(past))
  assert.ok(next)
  assert.equal(calls, 1)
})

// ── 8) 真机口径：三家 token 到半程还有几天（证据用）────────────────────────
test("T41-8) 真机 token：距半程为正数天", () => {
  const real = {
    quwork: { iat: 1_795_110_136, exp: 1_797_702_136 },
    officeace: { iat: 1_795_179_140, exp: 1_797_516_898 },
    codearts: { iat: 1_795_180_389, exp: 1_797_577_869 },
  }
  const now = Math.floor(Date.now() / 1000)
  for (const [name, { iat, exp }] of Object.entries(real)) {
    const left = msUntilHalfLife(iat, exp, now)
    const days = left / 86_400_000
    assert.ok(days > 0, `${name}：距半程还剩 ${days.toFixed(1)} 天（应为正数）`)
  }
})
