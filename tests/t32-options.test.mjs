// t32-options.test.mjs —— T-32：`auth.options` 界面开关（officeace / codearts）
//
// # 钉什么
//
//	① 两个 provider 各自声明自己的开关，形状符合宿主 `optionsOf()` 的严格 schema
//	   （`host-acc034d984c6.js` ≈2360-2382）：key `^[a-z0-9_-]{1,40}$`（**全小写**）、
//	   label 必填 ≤60、default 只认布尔、最多 16 项、placement 只认 "top"。
//	② `invite_mode`（原本就有）**形状是对的** —— 这里把它钉住，免得以后有人把它
//	   改成 camelCase 而界面上静默消失。
//	③ `trialbit` 真的接线：关掉后 `ensureTrialPackage` 立刻返回 `{status:"disabled"}`，
//	   一个上游请求都不打（等价于 `MAGPIE_OFFICEACE_NO_TRIAL_CLAIM=1`）。
//
// ⚠ 全部离线：`OfficeAceAuthPlugin` 的 `fetch` 由测试注入，零真实网络。

import test from "node:test"
import assert from "node:assert/strict"

import { OfficeAceAuthPlugin, OFFICEACE_OPTIONS, _internal } from "../index.mjs"
import { CodeArtsAuthPlugin, INVITE_MODE_OPTION } from "../src/codearts/index.mjs"
import { TRIAL_SKU_CODE } from "../src/api.mjs"

const ensureTrialPackage = _internal.ensureTrialPackage
const trialClaimCacheState = _internal.trialClaimCache

const OPTION_KEY = /^[a-z0-9_-]{1,40}$/

/** 宿主 `optionsOf()` 的校验（照源码抄，逐条对应）。 */
function assertOptionShape(o, where) {
  assert.match(o.key, OPTION_KEY, `${where}: key 不合规会被整项跳过: ${o.key}`)
  assert.equal(typeof o.label, "string", `${where}: label 必填（缺了整项消失）: ${o.key}`)
  assert.ok(o.label.trim().length > 0 && o.label.length <= 60, `${where}: label 长度 1~60: ${o.key}`)
  assert.equal(typeof o.default, "boolean", `${where}: default 只认布尔: ${o.key}`)
  assert.ok(!o.description || o.description.length <= 300, `${where}: description ≤300 字: ${o.key}`)
  assert.ok(!o.confirm || o.confirm.length <= 300, `${where}: confirm ≤300 字: ${o.key}`)
  if (o.placement !== undefined) assert.equal(o.placement, "top", `${where}: placement 只认 "top"`)
  for (const map of ["labels", "descriptions", "confirms"]) {
    if (!o[map]) continue
    assert.ok(Object.keys(o[map]).length <= 16, `${where}: ${map} ≤16 种语言: ${o.key}`)
    for (const [lang, word] of Object.entries(o[map])) {
      assert.ok(lang.trim().length <= 16, `${where}: 语言码 ≤16 字: ${lang}`)
      assert.equal(typeof word, "string", `${where}: ${map}.${lang} 必须是字符串`)
    }
  }
  return o
}

// ── ① OfficeAce 的开关 ──────────────────────────────────────────────

test("T32-O1) OfficeAce：auth.options 形状合规，只有 trialbit 一个开关", async () => {
  const p = await OfficeAceAuthPlugin({}, {})
  assert.ok(Array.isArray(p.auth.options), "auth.options 必须是数组")
  assert.equal(p.auth.options.length, 1)
  assert.deepEqual(p.auth.options.map((o) => o.key), ["trialbit"])
  for (const o of p.auth.options) assertOptionShape(o, "officeace")
  // 默认开：改造前后行为不变（真机一直在自动领体验版）
  assert.equal(p.auth.options[0].default, true)
  assert.deepEqual(OFFICEACE_OPTIONS.map((o) => o.key), ["trialbit"])
})

// ── ② CodeArts 的 invite_mode（原本就有，确认形状对）────────────────

test("T32-O2) CodeArts：invite_mode 形状正确（key 全小写 + placement:top + 中英文都有）", async () => {
  const p = await CodeArtsAuthPlugin({ client: {} }, { fetch: async () => new Response("{}") })
  const options = p.auth.options
  assert.ok(Array.isArray(options) && options.length >= 1)
  const invite = options.find((o) => o.key === "invite_mode")
  assert.ok(invite, "invite_mode 必须还在（改名 = 用户已有设置作废）")
  assertOptionShape(invite, "codearts")
  assert.equal(invite.placement, "top", "整体插件级开关：画在账号区下方 / Routing 上方")
  assert.equal(invite.default, false)
  assert.equal(invite.labels.zh, invite.label)
  // 常量与用法必须同名（`inviteModeOn()` 读的是 INVITE_MODE_KEY）
  assert.equal(invite.key, "invite_mode")
  assert.equal(INVITE_MODE_OPTION.key, invite.key, "常量与声明必须同一个 key")
})

// ── ③ trialbit 真接线 ──────────────────────────────────────────────

/** 假凭据：字段名与真实一致，值是明显的测试串。 */
const cred = { access: "AK-TEST", securityToken: "ST-TEST", refreshToken: "RT-TEST", accountId: "test-account" }

/** 造一个「会记账」的上游：任何请求都算一次。 */
function countingFetch(respond = () => Response.json({})) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(String(url))
    return respond(url, init)
  }
  return { calls, fetchImpl }
}

test("T32-O3) trialbit 关：ensureTrialPackage 立刻 disabled，零上游请求", async () => {
  const { calls, fetchImpl } = countingFetch()
  const p = await OfficeAceAuthPlugin(
    { magpie: { option: (_provider, key) => (key === "trialbit" ? false : undefined) } },
    { fetch: fetchImpl },
  )
  assert.ok(p.auth.usage, "装配仍然完整")

  const r = await ensureTrialPackage(cred, { enabled: false })
  assert.equal(r.status, "disabled")
  assert.equal(calls.length, 0, "关掉后不许打订阅/下单接口")
})

test("T32-O4) trialbit 开（默认）：走真实判定（已有 trial ⇒ present，不下单）", async () => {
  // `ensureTrialPackage` 内部按账号 identity 记忆（每进程只试一次），
  // 先清掉，免得被同进程里别的用例的顺序影响。
  trialClaimCacheState.clear()
  let claimed = 0
  const r = await ensureTrialPackage(cred, {
    enabled: true,
    readSubscription: async () => ({ skus: [{ sku_code: TRIAL_SKU_CODE }] }),
    claimTrialPackage: async () => {
      claimed += 1
      return { ok: true }
    },
  })
  assert.equal(r.status, "present", "订阅里已有 trial ⇒ present；开关打开不该改变这个判定")
  assert.equal(claimed, 0, "已有 trial 就不该下单")
  trialClaimCacheState.clear()
})