// t39-cache.test.mjs（T-39）缓存化：所有会打上游的钩子默认只读缓存。
//
// # 用户原话（这就是验收标准）
//
//	「所有的东西都需要缓存。更新缓存是我们来控制的，不要自动更新缓存」
//	「重启项目的时候，我不希望它就会自动去发送什么请求」
//
// # 判据
//
//	magpie 重启 → 重读模型列表 → **会不会对每个账号各打一次上游？**
//	改造后：模型目录有缓存 = 0 次，没缓存 = 1 次（**网关级**，不是账号数）；
//	额度 = 0 次（只由登录/重新登录写）。trialbit 默认关（自动下单是最强的自动打上游）。
//
// 这里每个用例都用**真临时目录**当 cacheDir（缓存文件真落盘），并用 URL 计数器
// 把「哪个端点被打了几次」变成可断言的数字。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { OfficeAceAuthPlugin, OFFICEACE_OPTIONS, _internal } from "../index.mjs"
import { MODELS_CACHE_FILE, USAGE_CACHE_FILE, readCacheEntry } from "../src/cache.mjs"
import { EXPIRY_LEAD_MS, OFFICIAL_MAAS_BASE, TOKEN_URL } from "../src/constants.mjs"
import { generateDpopKeyPair } from "../src/crypto.mjs"

process.env.MAGPIE_OFFICEACE_NO_TRIAL_CLAIM = "1"
process.env.MAGPIE_OFFICEACE_NO_BROWSER = "1"
process.env.OFFICEACE_USER_DATA_ROOT = path.join(os.tmpdir(), "officeace-t39-no-client")

const TEMP_DIRS = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "officeace-t39-"))
  TEMP_DIRS.push(dir)
  return dir
}
test.after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true })
})

/** 一份「有模型网关」的凭据（和真机字段一致，值是明显的测试串）。 */
function cred(overrides = {}) {
  return {
    access: "AK-TEST-T39",
    secret: "SK-TEST-T39",
    securityToken: "ST-TEST-T39",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "t39-acct-1",
    user_phone: "138****0000",
    modelAppKey: "APP-KEY-T39",
    modelAppSecret: "APP-SECRET-T39",
    maasBaseUrl: "",
    ...overrides,
  }
}

const record = (inner) => ({
  type: "oauth",
  access: JSON.stringify(inner),
  refresh: "RT-TEST-T39",
  expires: Date.parse(inner.expiresAt ?? "") || Date.now() + 3600_000,
  accountId: inner.accountId,
})

const MODELS_BODY = {
  data: [
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "glm-5.2", name: "GLM-5.2" },
  ],
}
const RATES_BODY = {
  models: [
    { model_name: "deepseek-v4.1-flash", cost_coefficient: 1 },
    { model_name: "glm-5.2", cost_coefficient: 0.2 },
  ],
}

/**
 * 换掉 globalThis.fetch，并按 URL 记账。
 * @param {(url: string) => Response|Promise<Response>} handler
 */
function stubFetch(t, handler) {
  const hits = []
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url)
    hits.push(u)
    return handler(u)
  })
  return {
    hits,
    count: (part) => hits.filter((u) => u.includes(part)).length,
  }
}

const defaultHandler = (u) => {
  if (u.includes("/v2/models")) return Response.json(MODELS_BODY)
  if (u.includes("/v1/model-token-rates")) return Response.json(RATES_BODY)
  return new Response("{}", { status: 404 })
}

// ── 1) 缓存命中 → 零上游（连 MaaS 探测都不发）────────────────────────────
test("T39-O1) auth.models 命中缓存 → 零上游（重启后连 hydration 都不发）", async (t) => {
  const dir = tempDir()
  const keyless = cred({ modelAppKey: undefined, modelAppSecret: undefined })
  const key = `acct:${_internal.maasPendingKey(keyless)}`
  fs.writeFileSync(
    path.join(dir, MODELS_CACHE_FILE),
    JSON.stringify({ [key]: { at: Date.now(), list: [{ id: "glm-5.2", name: "GLM 缓存", context: 1000, output: 100 }] } }),
  )

  const net = stubFetch(t, () => {
    throw new Error("缓存命中还发请求 = 失败")
  })
  const plugin = await OfficeAceAuthPlugin({ directory: dir }, {})
  const models = await plugin.provider.models({}, { auth: record(keyless) })

  assert.equal(net.hits.length, 0, `缓存命中时必须零上游（实际 ${net.hits.length} 次）`)
  assert.deepEqual(Object.keys(models), ["glm-5.2"])
  assert.equal(models["glm-5.2"].name, "GLM 缓存")
  assert.equal(models["glm-5.2"].limit.context, 1000)
})

// ── 2) 多账号并发未命中 → 网关级只 1 次 ─────────────────────────────────
test("T39-O2) 多账号并发 auth.models（无缓存）→ 模型目录只拉 **1 次**", async (t) => {
  const dir = tempDir()
  const net = stubFetch(t, defaultHandler)
  const plugin = await OfficeAceAuthPlugin({ directory: dir }, {})

  const accounts = ["a", "b", "c", "d", "e"].map((n) =>
    record(cred({ accountId: `t39-acct-${n}`, modelAppKey: `APP-${n}` })),
  )
  const out = await Promise.all(accounts.map((auth) => plugin.provider.models({}, { auth })))

  assert.equal(net.count("/v2/models"), 1, `5 个账号并发只能打 1 次模型目录（实际 ${net.count("/v2/models")} 次）`)
  for (const models of out) assert.ok(models["glm-5.2"], "每个账号都拿到目录")
})

// ── 3) 未命中 → 拉 1 次并写缓存；新实例（重启）零上游 ────────────────────
test("T39-O3) 无缓存 → 拉 1 次并写 officeace-models-cache.json；新实例读文件零上游", async (t) => {
  const dir = tempDir()
  const net = stubFetch(t, defaultHandler)
  const auth = record(cred())

  const first = await OfficeAceAuthPlugin({ directory: dir }, {})
  const models = await first.provider.models({}, { auth })
  assert.equal(net.count("/v2/models"), 1)
  assert.ok(models["glm-5.2"])

  const file = path.join(dir, MODELS_CACHE_FILE)
  assert.ok(fs.existsSync(file), "缓存文件必须落盘")
  const cache = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.ok(Array.isArray(cache[OFFICIAL_MAAS_BASE]?.list), "结构是 { [baseUrl]: { at, list } }")

  // 新实例 = magpie 重启：只读文件
  const net2 = stubFetch(t, () => {
    throw new Error("重启后不许打上游")
  })
  const second = await OfficeAceAuthPlugin({ directory: dir }, {})
  const again = await second.provider.models({}, { auth })
  assert.equal(net2.hits.length, 0, "重启后必须零上游")
  assert.ok(again["glm-5.2"])
})

// ── 4) 失败不写缓存（下次仍重试）────────────────────────────────────────
test("T39-O4) 目录拉取失败 → 回退静态表且**不写缓存**（下次还会重试）", async (t) => {
  const dir = tempDir()
  const net = stubFetch(t, (u) => (u.includes("/v2/models") ? new Response("boom", { status: 500 }) : new Response("{}")))
  const plugin = await OfficeAceAuthPlugin({ directory: dir }, {})

  const models = await plugin.provider.models({}, { auth: record(cred()) })
  assert.ok(Object.keys(models).length > 0, "必须回退静态表（不能给空目录）")
  assert.equal(readCacheEntry(dir, MODELS_CACHE_FILE, OFFICIAL_MAAS_BASE), null, "失败绝不能写缓存")

  await plugin.provider.models({}, { auth: record(cred()) })
  assert.equal(net.count("/v2/models"), 2, "失败后下一次仍然重试")
})

// ── 5) usage **不做缓存**：每次被问都真读 /v1/subscription（用户驳回「usage 也缓存」）
test("T39-O5) auth.usage 每次都真读 /v1/subscription（有缓存文件也不读它）", async (t) => {
  const dir = tempDir()
  const live = cred()
  // 预先放一份"过期数据"的额度缓存：钩子必须**无视**它
  fs.writeFileSync(
    path.join(dir, USAGE_CACHE_FILE),
    JSON.stringify({ [live.accountId]: { at: 1, windows: [{ name: "额度 · 缓存套餐", used: 0, display: "0 / 1" }] } }),
  )

  const net = stubFetch(t, (u) =>
    u.includes("/v1/subscription")
      ? Response.json({
          skus: [
            {
              sku_code: "officeace.personal.package.basic",
              sku_name: "基础版",
              quotas: [{ sku_attr_code: "officeace_points", sku_value: 1000, current_value: 500 }],
            },
          ],
          bonus_skus: [],
        })
      : new Response("{}", { status: 404 }),
  )

  const plugin = await OfficeAceAuthPlugin({ directory: dir }, {})
  const u = await plugin.auth.usage(async () => record(live), {})

  assert.ok(net.count("/v1/subscription") >= 1, `usage 必须真打上游（实际 ${net.count("/v1/subscription")} 次）`)
  assert.equal(net.count("/v1/subscription"), 1)
  const main = u.windows.find((w) => String(w.name) === "额度 · 基础版")
  assert.ok(main, `缺实时额度窗: ${JSON.stringify(u.windows)}`)
  assert.equal(main.limit, 1000, "用的是**实时**读到的数，不是缓存里的 1")
  assert.equal(u.error, undefined)
})

// ── 5b) 登录顺手写的额度快照只是副产品：钩子照样真读 ───────────────────────
test("T39-O5b) 登录写额度快照（副产品）→ auth.usage 仍然真读上游", async (t) => {
  const dir = tempDir()
  const authFile = path.join(dir, "plugin-auth.json")
  const live = cred({ accountId: "acc-t39", expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  fs.writeFileSync(authFile, JSON.stringify({ officeace: record(live) }))

  const subscription = {
    skus: [
      {
        sku_code: "officeace.personal.package.basic",
        sku_name: "基础版",
        quotas: [{ sku_attr_code: "officeace_points", sku_value: 1000, current_value: 500 }],
      },
    ],
    bonus_skus: [],
  }

  stubFetch(t, (u) => (u.includes("/v1/subscription") ? Response.json(subscription) : new Response("{}", { status: 404 })))

  const plugin = await OfficeAceAuthPlugin(
    { directory: dir },
    {
      authFile,
      probeClient: async () => ({ loggedIn: true, accountId: "acc-t39", userName: "t39", sessionId: "sid" }),
    },
  )
  const started = await plugin.auth.methods[0].authorize()
  assert.equal(started.opened, true, "走的是「复用客户端登录态」这条快路径")
  const done = await started.callback()
  assert.equal(done.type, "success")

  // 额度钩子：仍然真读一次（不读那份快照）
  const net = stubFetch(t, (u) =>
    u.includes("/v1/subscription")
      ? Response.json({
          skus: [
            {
              sku_code: "officeace.personal.package.basic",
              sku_name: "基础版",
              quotas: [{ sku_attr_code: "officeace_points", sku_value: 2000, current_value: 1500 }],
            },
          ],
          bonus_skus: [],
        })
      : new Response("{}", { status: 404 }),
  )
  const u = await plugin.auth.usage(async () => record(live), {})
  assert.equal(net.count("/v1/subscription"), 1, "usage 必须真打上游")
  const main = u.windows.find((w) => String(w.name) === "额度 · 基础版")
  assert.ok(main, `缺额度窗: ${JSON.stringify(u.windows)}`)
  assert.equal(main.limit, 2000, "用的是实时值（登录那次是 1000）")
  assert.equal(main.amount, 1500)
})

// ── 6) trialbit 默认 **开**；refreshLead = 10 分钟（都保持原样）────────────
test("T39-O6) trialbit 默认 **true**；refreshLead = EXPIRY_LEAD_MS（续期不动）", async () => {
  const plugin = await OfficeAceAuthPlugin({}, {})
  const trialbit = OFFICEACE_OPTIONS.find((o) => o.key === "trialbit")
  assert.ok(trialbit, "trialbit 必须还在")
  assert.equal(trialbit.default, true, "默认自动领取体验版（T-39 不动它）")
  assert.equal(plugin.auth.options.find((o) => o.key === "trialbit").default, true)
  assert.equal(plugin.auth.refreshLead, 10 * 60 * 1000, "续期节奏：10 分钟（与 EXPIRY_LEAD_MS 同口径）")
  assert.equal(plugin.auth.refreshLead, EXPIRY_LEAD_MS)
})

// ── 7) 续期：保持原样（per 10 分钟 lead，钩子照旧续）──────────────────────
test("T39-O7) auth.refresh 保持原样：凭据可续就续（会打 TOKEN_URL）", async (t) => {
  const key = await generateDpopKeyPair()
  // 注意：magpie 只在「临期」（refreshLead）时才问 refresh，钩子本身不做时间判断
  const live = { ...cred(), dpopPrivateJwk: key.privateJwk, codeVerifier: "t39-verifier", refreshToken: "RT-T39" }

  const net = stubFetch(t, (u) => {
    if (u === TOKEN_URL) {
      return Response.json({
        credentials: {
          access_key_id: "new-ak",
          secret_access_key: "new-sk",
          security_token: "new-st",
          expiration: new Date(Date.now() + 3600_000).toISOString(),
        },
        refresh_token: "new-refresh",
      })
    }
    return new Response("{}", { status: 404 })
  })

  const plugin = await OfficeAceAuthPlugin({}, {})
  const next = await plugin.auth.refresh(record(live), {})
  assert.ok(next, "凭据可续 ⇒ 直接续（没有额外的时间闸）")
  assert.equal(net.count(TOKEN_URL), 1, "真打了一次续期")
  assert.equal(JSON.parse(next.access).access, "new-ak")
})
