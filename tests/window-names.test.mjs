// window-names.test.mjs T-31：窗口命名一致性（跨插件统一）
//
// 规范见 `magpie-plugins/UNIFIED-PLAN.md` §1.1：**每一个**窗口名都必须以三个前缀之一开头。
//
//	额度 · <名称>   正常参与路由的额度（有 used，或 balance+unit）
//	停用 · <原因>   used:100 ⇒ 路由跳过该号（唯一手段）
//	说明 · <主题>   aside:true ⇒ 只解释，不参与路由
//
// 本插件（果办 OfficeAce + 码道 CodeArts）**一条 `停用 · ` 都不该有**：
// 两个上游都没有「这个号不能用了」的证据链，伪造 used:100 会把健康的号判死（规范 §4.3 第 2 条）。
//
// 这条测试是**一致性**测试，不替代任何语义断言：它只保证「名字没漂回旧写法」，
// 且前缀与字段语义（aside / used）不打架。

import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal as x } from "../src/codearts/index.mjs"
import { fetchUsage } from "../src/api.mjs"
import { QUOTA_PREFIX, STOP_PREFIX, NOTE_PREFIX, unreadableWindow } from "../src/window-names.mjs"

const PREFIXES = [QUOTA_PREFIX, STOP_PREFIX, NOTE_PREFIX]

/** 前缀与字段语义必须一致（名字骗人比没名字更糟）。 */
function assertPrefixMatchesFields(name, w, label) {
  if (name.startsWith(STOP_PREFIX)) {
    assert.equal(w.used, 100, `[${label}]「${name}」是停用窗 ⇒ used 必须是 100`)
    assert.equal(w.aside, undefined, `[${label}]「${name}」是停用窗 ⇒ 不能带 aside`)
  }
  if (name.startsWith(NOTE_PREFIX)) {
    assert.equal(w.aside, true, `[${label}]「${name}」是说明窗 ⇒ 必须 aside:true`)
    assert.equal(w.used, undefined, `[${label}]「${name}」是说明窗 ⇒ 不许带 used`)
  }
}

/** 果办订阅面：一个套餐桶 + 一个活动桶（含一个已过期的桶，aside 也要合规范）。 */
const SUBSCRIPTION = {
  skus: [
    {
      sku_code: "officeace_personal_trial.trial",
      sku_name: "个人体验版",
      quotas: [{ sku_attr_code: "officeace_points", sku_value: 500, current_value: 0, expired_time: "" }],
    },
    {
      sku_code: "officeace_personal_monthly",
      sku_name: "个人版",
      quotas: [{ sku_attr_code: "officeace_points", sku_value: 4000, current_value: 1780, expired_time: "2031-01-01T00:00:00Z" }],
    },
    {
      sku_code: "officeace_personal_old",
      sku_name: "旧套餐",
      quotas: [{ sku_attr_code: "officeace_points", sku_value: 100, current_value: 100, expired_time: "2020-01-01T00:00:00Z" }],
    },
  ],
  bonus_skus: [
    { activity_name: "每日签到有礼", points: 100, current_value: 100, expired_time: "2031-01-01T00:00:00Z" },
    { activity_name: "新用户专属福利", points: 4000, current_value: 1780, expired_time: "2031-01-01T00:00:00Z" },
  ],
}

test("T-31：所有窗口名都必须以「额度 · / 停用 · / 说明 · 」之一开头（且前缀与字段语义一致）", async (t) => {
  // ── ① 果办 OfficeAce：订阅面（真实签名链路 + 只替换最后一步 fetch）──
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async () =>
    new Response(JSON.stringify(SUBSCRIPTION), { status: 200, headers: { "content-type": "application/json" } })

  const officeace = await fetchUsage({ access: "AK/ST", secret: "SK", securityToken: "ST" })
  assert.ok(officeace.windows.length >= 4, `果办订阅面没产出窗口: ${JSON.stringify(officeace.windows)}`)

  // ── ② 码道 CodeArts：四个积分桶 + 免费额度池 ──
  const codearts = x.usageFromStatistics(
    {
      package: { package_name_cn: "企业版" },
      metrics: [
        { name: "usageTotalPackageCredit", package_credit_amount: 1000, package_credit_remain: 250 },
        { name: "usageBasicPackageCredit", package_credit_amount: 1000, package_credit_remain: 250 },
        { name: "usageOnDemandPackageCredit", package_credit_amount: 20000, package_credit_remain: 20000 },
        { name: "usageBonusPackageCredit", package_credit_amount: 6000, package_credit_remain: 6000 },
      ],
    },
    { result: { daily_token_limit: 10_000_000, daily_tokens_used: 2_500_000 } },
  )
  assert.equal(codearts.windows.length, 5, `码道应出 5 个窗口，实际: ${JSON.stringify(codearts.windows)}`)

  // ── ③ 读取失败：说明窗（不是 error）──
  const unreadable = unreadableWindow("订阅查询失败：HTTP 502")

  /** @type {any[]} */
  const seen = [
    ...officeace.windows.map((w) => ({ label: "officeace", name: String(w?.name ?? ""), w })),
    ...codearts.windows.map((w) => ({ label: "codearts", name: String(w?.name ?? ""), w })),
    { label: "unreadable", name: String(unreadable.name), w: unreadable },
  ]

  // ④ 名字前缀
  for (const { label, name } of seen) {
    assert.ok(
      PREFIXES.some((p) => name.startsWith(p)),
      `[${label}] 窗口名「${name}」不符合 T-31 命名：必须以 ${PREFIXES.join(" / ")} 之一开头`,
    )
  }

  // ⑤ 前缀 ↔ 字段语义
  for (const { label, name, w } of seen) assertPrefixMatchesFields(name, w, label)

  // ⑥ 本插件一个「停用」窗都不该有（没有判死一个号的依据）
  assert.equal(seen.filter((s) => s.name.startsWith(STOP_PREFIX)).length, 0, "不许伪造 used:100")

  // ⑦ 名字里不许再写数值（「· 剩 N」）——magpie 自己按 amount/limit 渲染
  for (const { label, name } of seen) {
    assert.equal(/· 剩 /.test(name), false, `[${label}] 窗口名里不许写「· 剩 N」: ${name}`)
  }

  // ⑧ 两个前缀都真的出现过（测试别空转）
  for (const p of [QUOTA_PREFIX, NOTE_PREFIX]) {
    assert.ok(seen.some((s) => s.name.startsWith(p)), `没有产出过「${p}…」窗口，一致性测试名存实亡`)
  }
})
