// paste-import.test.mjs 「登录弹窗里的导入按钮」：从粘贴的文本导入 OfficeAce 账号。
//
// 断言全部来自宿主源码（host-acc034d984c6.js）：
//   2822  oauth 方法的 authorize 必须返回带 callback 的对象
//   2853  callback() → keptAs → save 落盘
//   1346-1370  client.auth.set 是插件写账号的正规通道
//   2758-2763  save() 写的 body 是 {type:"oauth", refresh, access, expires, ...extra}
//
// ⚠ 这台机器上没有网络：所有测试都注入 fetch + 一个只记录写入的假 client。

process.env.MAGPIE_OFFICEACE_NO_AUTO_UPDATE = "1"

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OfficeAceAuthPlugin } from "../index.mjs"
import { generateDpopKeyPair } from "../src/crypto.mjs"
import { PASTE_LABEL, authBodyOf, nextAccountKey } from "../src/paste-import.mjs"

const { privateJwk } = await generateDpopKeyPair()
const expiry = "2030-01-01T00:00:00Z"
const jwt = (profile, suffix) => `mock.${Buffer.from(JSON.stringify({ user_profile: profile })).toString("base64url")}.${suffix}`

/** 一份合法的 officeace 导出行（值都是假的）。 */
const officeAceRow = (over = {}) => ({
  provider: "officeace",
  access: over.access ?? "paste-ak",
  secret: "paste-sk",
  securityToken: "paste-st",
  refreshToken: over.refreshToken ?? jwt({ account_id: over.domain ?? "paste-domain" }, "p"),
  expiresAt: expiry,
  dpopPrivateJwk: privateJwk,
  user_phone: "123****4567",
})

function tempAuthFile() {
  const dir = mkdtempSync(join(tmpdir(), "officeace-paste-"))
  return join(dir, "plugin-auth.json")
}

function fakeClient() {
  /** @type {Array<{key: string, body: any}>} */
  const writes = []
  /** @type {any[]} */
  const toasts = []
  const client = {
    auth: {
      set: async ({ path, body }) => {
        writes.push({ key: path.id, body })
      },
    },
    tui: { showToast: (o) => toasts.push(o) },
  }
  return { writes, toasts, client }
}

/** 只生成插件实例，不触发任何联网（真实探测都是短超时 + 失败兜底）。 */
async function plugin(t, { file = tempAuthFile(), client = fakeClient().client } = {}) {
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("意外的联网调用")
  })
  /** @type {any[]} */
  const logs = []
  const instance = await OfficeAceAuthPlugin({ client }, { authFile: file, fetch, probeClient: async () => null })
  t.after(() => assert.equal(fetch.mock.callCount(), 0))
  return { instance, logs }
}

test("登录弹窗里多了一项：从文件导入（粘贴 JSON / NDJSON）", async (t) => {
  const { instance } = await plugin(t)
  const method = instance.auth.methods.find((m) => String(m.label).includes("从文件导入"))
  assert.ok(method, "auth.methods 里必须有「从文件导入」")
  assert.equal(method.label, PASTE_LABEL)
  assert.equal(method.type, "oauth", "必须是 oauth（账号卡/续期/签到都读 access+refresh）")
  assert.equal(method.labels.en, "import from text (JSON / NDJSON)")
  assert.equal(method.prompts[0].type, "text")
  assert.equal(method.prompts[0].key, "text")
  assert.equal(typeof method.authorize, "function")
})

test("粘贴单个账号 JSON：callback 返回 success，写盘 body 与宿主 save() 同构", async (t) => {
  const file = tempAuthFile()
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = instance.auth.methods.find((m) => String(m.label).includes("从文件导入"))

  const started = await method.authorize({ text: JSON.stringify(officeAceRow()) })
  assert.equal(typeof started.callback, "function", "oauth 方法必须给 callback")
  assert.equal(started.opened, true)

  const r = await started.callback()
  assert.equal(r.type, "success")
  assert.equal(r.uid, "paste-domain")
  assert.equal(r.refresh, officeAceRow().refreshToken)

  assert.equal(writes.length, 1)
  assert.match(writes[0].key, /^officeace#/)
  assert.deepEqual(writes[0].body, authBodyOf(r))
  assert.equal(writes[0].body.type, "oauth")
})

test("粘贴 NDJSON 两行：两条都导入（第 1 条给宿主，第 2 条自己写）", async (t) => {
  const file = tempAuthFile()
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = instance.auth.methods.find((m) => String(m.label).includes("从文件导入"))

  const text = [
    JSON.stringify(officeAceRow({ domain: "d-one", access: "ak-one", refreshToken: jwt({ account_id: "d-one" }, "one") })),
    JSON.stringify(officeAceRow({ domain: "d-two", access: "ak-two", refreshToken: jwt({ account_id: "d-two" }, "two") })),
  ].join("\n")
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(r.uid, "d-one", "第 1 条交宿主保存")
  assert.deepEqual(writes.map((w) => w.body.uid), ["d-one", "d-two"])
  assert.notEqual(writes[0].key, writes[1].key, "两个号不能抢同一个账号键")
})

test("坏行只失败那一行：好行照样导入", async (t) => {
  const file = tempAuthFile()
  const { writes, toasts, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = instance.auth.methods.find((m) => String(m.label).includes("从文件导入"))

  const text = `${JSON.stringify(officeAceRow({ domain: "d-ok", refreshToken: jwt({ account_id: "d-ok" }, "ok") }))}\n{ 这一行不是 JSON`
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(writes.length, 1)
  // 坏行只在**同一张文件**里才看得见：宿主只转述错误，成功时不会转述我们的 toast，
  // 所以把「哪条没进来」随结果一起带回（`note`）。
  assert.match(String(r.note ?? ""), /第 2 条：这一行不是合法的 JSON/)
})

test("磁盘上已有的账号不重复导入（按 refresh token 去重）", async (t) => {
  const file = tempAuthFile()
  const refresh = jwt({ account_id: "dup-domain" }, "dup")
  writeFileSync(file, JSON.stringify({ officeace: { type: "oauth", access: "{}", refresh } }))
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = instance.auth.methods.find((m) => String(m.label).includes("从文件导入"))

  const started = await method.authorize({ text: JSON.stringify(officeAceRow({ domain: "dup-domain", refreshToken: refresh })) })
  const r = await started.callback()

  assert.equal(r.type, "failed")
  assert.match(r.error, /已经在 magpie 里/)
  assert.equal(writes.length, 0)
})

test("空输入 / 认不出的内容返回 failed 而不是抛异常", async (t) => {
  const { instance } = await plugin(t)
  const method = instance.auth.methods.find((m) => String(m.label).includes("从文件导入"))

  const empty = await method.authorize({ text: "  " })
  assert.equal(empty.type, "failed")

  const started = await method.authorize({ text: "hello world" })
  const r = await started.callback()
  assert.equal(r.type, "failed")
  assert.ok(r.error)
})

test("nextAccountKey 避开已被占用的键", () => {
  const taken = new Set(["officeace#abc123"])
  const key = nextAccountKey("officeace", taken)
  assert.match(key, /^officeace#/)
  assert.notEqual(key, "officeace#abc123")
  assert.equal(taken.has(key), true)
})