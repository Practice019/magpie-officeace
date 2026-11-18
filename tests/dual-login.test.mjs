import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

import { OfficeAceAuthPlugin } from "../index.mjs"
import { CodeArtsAuthPlugin, _internal as codeartsInternal } from "../src/codearts/index.mjs"

process.env.MAGPIE_OFFICEACE_NO_TRIAL_CLAIM = "1"

const AUTH_FILE = path.join(os.tmpdir(), "officeace-dual-login-no-auth.json")
const OFFICEACE_URL = "https://auth.huaweicloud.com/authui/login.html?service=officeace"
const CODEARTS_URL = "http://127.0.0.1:12345/portal/authorize?ticket=t"
const SHARED_PROFILE = "C:\\fake\\officeace-dual-profile"

const OFFICEACE_CRED = {
  access: "AK-OA",
  secret: "SK-OA",
  securityToken: "ST-OA",
  projectId: "",
  expiresAt: "2031-01-01T00:00:00Z",
  refreshToken: "RT-OA",
  accountId: "officeace-account",
  user_phone: "138****8000",
}

function codeCredential(name, token) {
  return {
    access_key_id: `AK-CA-${name}`,
    secret_access_key: "SK-CA",
    security_token: "ST-CA",
    refresh_token: token,
    expires_at: "2031-01-01T00:00:00Z",
    user_name: name,
    user_id: `u-${name}`,
    code_verifier: "verifier",
  }
}

function codeOutcome(name, token) {
  const cred = codeCredential(name, token)
  return { access: JSON.stringify(cred), expires: Date.parse(cred.expires_at) }
}

function makeClient() {
  const sets = []
  const logs = []
  return {
    auth: {
      async set({ path: target, body }) {
        sets.push({ id: target.id, body })
      },
    },
    app: {
      log(entry) {
        logs.push(entry)
      },
    },
    sets,
    logs,
  }
}

function makeFetcher() {
  const calls = []
  const fetcher = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes("/v1/claw/client-permission-validate")) {
      return Response.json({
        subscription: {
          model_info: {
            model_auth_info: { model_app_key: "oa-app-key", model_app_secret: "oa-app-secret" },
            model_api_url_base: "",
          },
        },
      })
    }
    return new Response("{}", { status: 401 })
  }
  return { fetcher, calls }
}

function makeIsolated({ ok = true, error = null } = {}) {
  const launches = []
  const closes = []
  const removals = []
  const events = []
  async function isolatedLogin(options) {
    launches.push(options)
    events.push({ type: "launch", url: options.url })
    return {
      ok,
      error,
      userDataDir: SHARED_PROFILE,
      async close() {
        closes.push(options.url)
        events.push({ type: "close", url: options.url })
      },
      async removeProfile() {
        removals.push(options.url)
        events.push({ type: "remove", url: options.url })
        return { removed: true }
      },
    }
  }
  return { isolatedLogin, launches, closes, removals, events }
}

function makeCodeArtsStart(result, counter) {
  return async () => ({
    loginUrl: CODEARTS_URL,
    result,
    async close() {
      counter.closed += 1
    },
  })
}

async function makePlugin({ client, isolated, beginLogin, startCodeArtsLogin, codeArtsLoginTimeoutMs, fetcher }) {
  return OfficeAceAuthPlugin(
    { client },
    {
      authFile: AUTH_FILE,
      fetch: fetcher,
      beginLogin,
      startCodeArtsLogin,
      isolatedLogin: isolated,
      ...(codeArtsLoginTimeoutMs ? { codeArtsLoginTimeoutMs } : {}),
    },
  )
}

test("成功路径：同一临时 profile 先果办后码道，写入码道记录并返回果办成功", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const counter = { closed: 0 }
  let officeClosed = 0

  const plugin = await makePlugin({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    beginLogin: async () => ({
      url: OFFICEACE_URL,
      result: Promise.resolve(OFFICEACE_CRED),
      close() {
        officeClosed += 1
      },
    }),
    startCodeArtsLogin: makeCodeArtsStart(Promise.resolve(codeOutcome("success-user", "RT-CA-SUCCESS")), counter),
  })

  const handle = await plugin.auth.methods[2].authorize()
  assert.equal(handle.url, OFFICEACE_URL)
  assert.equal(handle.opened, true)
  assert.equal(handle.method, "auto")
  assert.equal(isolated.launches.length, 1)
  assert.equal(isolated.launches[0].url, OFFICEACE_URL)
  assert.equal(isolated.launches[0].keepProfile, true)

  const result = await handle.callback()

  assert.equal(result.type, "success")
  assert.equal(JSON.parse(result.access).securityToken, "ST-OA", "返回的是果办自己的凭据")
  assert.equal(isolated.launches.length, 2)
  assert.equal(isolated.launches[1].url, CODEARTS_URL)
  assert.equal(isolated.launches[1].userDataDir, SHARED_PROFILE, "第二次启动复用第一次的临时 profile")
  assert.equal(isolated.launches[1].keepProfile, true)
  assert.equal(isolated.launches[0].anchorTab, true, "果办窗口需要空白锚点标签")
  assert.equal(isolated.launches[1].anchorTab, true, "码道窗口也需要空白锚点标签")
  const officeClose = isolated.events.findIndex((e) => e.type === "close" && e.url === OFFICEACE_URL)
  const codeLaunch = isolated.events.findIndex((e) => e.type === "launch" && e.url === CODEARTS_URL)
  assert.ok(officeClose > codeLaunch, "果办窗口必须保持到码道窗口打开之后")

  assert.equal(client.sets.length, 1, "只写码道一条记录，不双写同一份 STS")
  assert.ok(client.sets[0].id.startsWith("codearts"))
  const written = JSON.parse(client.sets[0].body.access)
  assert.equal(written.access_key_id, "AK-CA-success-user")
  assert.equal(written.model_app_key, "oa-app-key", "写入前完成 OfficeAce MaaS enrichment")

  assert.ok(isolated.closes.includes(OFFICEACE_URL), "果办窗口关闭")
  assert.ok(isolated.closes.includes(CODEARTS_URL), "码道窗口关闭")
  assert.deepEqual(isolated.removals, [CODEARTS_URL], "结束时删除共享 profile")
  assert.equal(counter.closed, 1, "码道回调服务器关闭")
  assert.equal(officeClosed, 0)
})

test("码道超时：果办仍成功，不写码道记录，日志提示可单独登录", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const counter = { closed: 0 }

  const plugin = await makePlugin({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    codeArtsLoginTimeoutMs: 25,
    beginLogin: async () => ({ url: OFFICEACE_URL, result: Promise.resolve(OFFICEACE_CRED), close() {} }),
    startCodeArtsLogin: makeCodeArtsStart(new Promise(() => {}), counter),
  })

  const handle = await plugin.auth.methods[2].authorize()
  const started = Date.now()
  const result = await handle.callback()

  assert.ok(Date.now() - started < 1000, "超时有界，不悬挂")
  assert.equal(result.type, "success")
  assert.equal(JSON.parse(result.access).securityToken, "ST-OA")
  assert.equal(client.sets.length, 0, "超时不能写码道记录")
  assert.ok(client.logs.some((entry) => String(entry.message).includes("码道授权未完成，可单独登录")))
  assert.equal(counter.closed, 1)
  assert.ok(isolated.closes.includes(OFFICEACE_URL))
  assert.ok(isolated.closes.includes(CODEARTS_URL))
  assert.deepEqual(isolated.removals, [CODEARTS_URL])
})

test("码道失败：果办仍成功，不写码道记录，日志提示可单独登录", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const counter = { closed: 0 }
  const codeFailure = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("码道页面报错")), 5)
  })

  const plugin = await makePlugin({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    beginLogin: async () => ({ url: OFFICEACE_URL, result: Promise.resolve(OFFICEACE_CRED), close() {} }),
    startCodeArtsLogin: makeCodeArtsStart(codeFailure, counter),
  })

  const handle = await plugin.auth.methods[2].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "success")
  assert.equal(client.sets.length, 0)
  assert.ok(client.logs.some((entry) => String(entry.message).includes("码道授权未完成，可单独登录")))
  assert.equal(counter.closed, 1)
  assert.deepEqual(isolated.removals, [CODEARTS_URL])
})

test("第一窗口启动失败：不伪造成功，错误可解释且释放两个 OAuth", async () => {
  const client = makeClient()
  const isolated = makeIsolated({ ok: false, error: "未找到 Chromium 浏览器" })
  const { fetcher } = makeFetcher()
  const counter = { closed: 0 }
  let officeClosed = 0

  const plugin = await makePlugin({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    beginLogin: async () => ({
      url: OFFICEACE_URL,
      result: new Promise(() => {}),
      close() {
        officeClosed += 1
      },
    }),
    startCodeArtsLogin: makeCodeArtsStart(Promise.resolve(codeOutcome("window-fail", "RT-CA-FAIL")), counter),
  })

  const handle = await plugin.auth.methods[2].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "failed")
  assert.match(result.error, /未找到 Chromium 浏览器/)
  assert.equal(client.sets.length, 0)
  assert.equal(isolated.launches.length, 1, "第一窗口失败就不开第二窗口")
  assert.equal(counter.closed, 1, "码道回调服务器取消")
  assert.equal(officeClosed, 1, "果办轮询取消")
})

test("码道已有同身份记录：written:false reason exists，果办仍成功且不覆盖", async () => {
  const name = "exists-user"
  codeartsInternal.noteProviderAccount("codearts", name)

  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const counter = { closed: 0 }

  const plugin = await makePlugin({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    beginLogin: async () => ({ url: OFFICEACE_URL, result: Promise.resolve(OFFICEACE_CRED), close() {} }),
    startCodeArtsLogin: makeCodeArtsStart(Promise.resolve(codeOutcome(name, "RT-CA-EXISTS")), counter),
  })

  const handle = await plugin.auth.methods[2].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "success")
  assert.equal(JSON.parse(result.access).securityToken, "ST-OA")
  assert.equal(client.sets.length, 0, "已存在同身份记录时不覆盖")
  assert.ok(client.logs.some((entry) => String(entry.message).includes("未覆盖已存在账号")))
  assert.equal(counter.closed, 1)
  assert.deepEqual(isolated.removals, [CODEARTS_URL])
})

test("果办失败时关闭码道服务器与窗口，不打开第二个窗口", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const counter = { closed: 0 }
  const officeFailure = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("果办登录已取消")), 5)
  })

  const plugin = await makePlugin({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    beginLogin: async () => ({
      url: OFFICEACE_URL,
      result: officeFailure,
      close() {},
    }),
    startCodeArtsLogin: makeCodeArtsStart(Promise.resolve(codeOutcome("officeace-fail", "RT-CA-OA-FAIL")), counter),
  })

  const handle = await plugin.auth.methods[2].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "failed")
  assert.match(result.error, /果办登录已取消/)
  assert.equal(isolated.launches.length, 1)
  assert.equal(counter.closed, 1)
  assert.ok(isolated.closes.includes(OFFICEACE_URL))
  assert.equal(isolated.removals.length, 1)
  assert.equal(client.sets.length, 0)
})

function officeCredential(accountId = "officeace-account") {
  return {
    ...OFFICEACE_CRED,
    accountId,
    refreshToken: `RT-OA-${accountId}`,
  }
}

async function makeCodeartsDual({ client, isolated, codeResult, officeResult, officeThrows = false, officeTimeoutMs, fetcher }) {
  let officeStarts = 0
  const counter = { closed: 0 }
  const plugin = await CodeArtsAuthPlugin(
    { client },
    {
      fetch: fetcher,
      loginMethod: {
        start: async () => ({
          loginUrl: CODEARTS_URL,
          result: codeResult,
          async close() {
            counter.closed += 1
          },
        }),
      },
      openIsolated: isolated,
      officeAceLoginTimeoutMs: officeTimeoutMs,
      beginOfficeAceLogin: async () => {
        officeStarts += 1
        if (officeThrows) throw new Error("果办登录启动失败")
        return {
          url: OFFICEACE_URL,
          result: officeResult,
          async close() {},
        }
      },
    },
  )
  return { plugin, counter, officeStarts: () => officeStarts }
}

test("码道入口成功：同一临时 profile 先码道后果办，写入果办独立记录", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const office = officeCredential("domain-codearts-success")
  const { plugin, counter } = await makeCodeartsDual({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    codeResult: Promise.resolve(codeOutcome("co-success", "RT-CA-SUCCESS")),
    officeResult: Promise.resolve(office),
  })

  const handle = await plugin.auth.methods[1].authorize()
  assert.equal(handle.url, CODEARTS_URL)
  assert.equal(handle.opened, true)
  const result = await handle.callback()

  assert.equal(result.type, "success")
  assert.equal(JSON.parse(result.access).access_key_id, "AK-CA-co-success")
  assert.equal(isolated.launches.length, 2)
  assert.equal(isolated.launches[0].url, CODEARTS_URL)
  assert.equal(isolated.launches[0].anchorTab, true)
  assert.equal(isolated.launches[1].url, OFFICEACE_URL)
  assert.equal(isolated.launches[1].userDataDir, SHARED_PROFILE)
  assert.equal(isolated.launches[1].anchorTab, true)
  const codeClose = isolated.events.findIndex((e) => e.type === "close" && e.url === CODEARTS_URL)
  const officeLaunch = isolated.events.findIndex((e) => e.type === "launch" && e.url === OFFICEACE_URL)
  assert.ok(codeClose > officeLaunch, "码道窗口必须保持到果办窗口打开之后")

  assert.equal(client.sets.length, 2, "码道和果办各写一条记录")
  const codeSet = client.sets.find((s) => s.id.startsWith("codearts"))
  const officeSet = client.sets.find((s) => s.id.startsWith("officeace"))
  assert.ok(codeSet)
  assert.ok(officeSet)
  const officeBody = JSON.parse(officeSet.body.access)
  assert.equal(officeBody.securityToken, "ST-OA", "果办记录使用果办自己的凭据")
  assert.equal(officeBody.refreshToken, `RT-OA-domain-codearts-success`)
  assert.equal(counter.closed, 1)
  assert.deepEqual(isolated.removals, [OFFICEACE_URL])
})

test("码道入口：果办超时仍返回码道成功，不写果办记录", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const { plugin } = await makeCodeartsDual({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    codeResult: Promise.resolve(codeOutcome("co-timeout", "RT-CA-TIMEOUT")),
    officeResult: new Promise(() => {}),
    officeTimeoutMs: 25,
  })

  const handle = await plugin.auth.methods[1].authorize()
  const started = Date.now()
  const result = await handle.callback()

  assert.ok(Date.now() - started < 1000)
  assert.equal(result.type, "success")
  assert.equal(client.sets.length, 1)
  assert.ok(client.sets[0].id.startsWith("codearts"))
  assert.ok(client.logs.some((entry) => String(entry.message).includes("果办授权未完成，可单独登录")))
})

test("码道入口：果办启动失败仍返回码道成功，不写果办记录", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const { plugin } = await makeCodeartsDual({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    codeResult: Promise.resolve(codeOutcome("co-office-fail", "RT-CA-OA")),
    officeResult: new Promise(() => {}),
    officeThrows: true,
  })

  const handle = await plugin.auth.methods[1].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "success")
  assert.equal(client.sets.length, 1)
  assert.ok(client.sets[0].id.startsWith("codearts"))
  assert.ok(client.logs.some((entry) => String(entry.message).includes("果办授权未完成，可单独登录")))
})

test("码道入口：果办已有同身份记录时不覆盖，码道仍成功", async () => {
  const account = "domain-codearts-exists"
  codeartsInternal.noteProviderAccount("officeace", account)
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const { plugin } = await makeCodeartsDual({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    codeResult: Promise.resolve(codeOutcome("co-exists", "RT-CA-EXISTS")),
    officeResult: Promise.resolve(officeCredential(account)),
  })

  const handle = await plugin.auth.methods[1].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "success")
  assert.equal(client.sets.length, 1, "已有果办同身份记录时不覆盖")
  assert.ok(client.sets[0].id.startsWith("codearts"))
  assert.ok(client.logs.some((entry) => String(entry.message).includes("未覆盖已存在账号")))
})

test("码道入口：码道失败时不启动果办，返回失败", async () => {
  const client = makeClient()
  const isolated = makeIsolated()
  const { fetcher } = makeFetcher()
  const { plugin, officeStarts } = await makeCodeartsDual({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    codeResult: Promise.reject(new Error("码道页面报错")),
    officeResult: Promise.resolve(officeCredential("domain-never")),
  })

  const handle = await plugin.auth.methods[1].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "failed")
  assert.match(result.error, /码道页面报错/)
  assert.equal(officeStarts(), 0)
  assert.equal(client.sets.length, 0)
  assert.equal(isolated.launches.length, 1)
  assert.equal(isolated.removals.length, 1)
})

test("码道入口：第一窗口启动失败时不伪造成功", async () => {
  const client = makeClient()
  const isolated = makeIsolated({ ok: false, error: "未找到 Chromium 浏览器" })
  const { fetcher } = makeFetcher()
  const { plugin, counter } = await makeCodeartsDual({
    client,
    isolated: isolated.isolatedLogin,
    fetcher,
    codeResult: Promise.resolve(codeOutcome("co-window-fail", "RT-CA-WINDOW")),
    officeResult: Promise.resolve(officeCredential("domain-window")),
  })

  const handle = await plugin.auth.methods[1].authorize()
  const result = await handle.callback()

  assert.equal(result.type, "failed")
  assert.match(result.error, /未找到 Chromium 浏览器/)
  assert.equal(client.sets.length, 0)
  assert.equal(counter.closed, 1)
  assert.equal(isolated.launches.length, 1)
})
