# 华为云一次接码获取两个平台凭据：验证报告与实现说明

> 日期：2026-11-18  
> 适用仓库：`D:\project_GIT\test\20261113\magpie-officeace`  
> 结论：**同一个华为云账号，一次短信验证可以拿到果办 OfficeAce 和码道 CodeArts 两份凭据。**  
> 关键前提：两次 OAuth 必须在**同一个浏览器会话**里串行完成；不是把同一个 authorization code 兑换两次。

---

## 1. 给实现 Agent 的结论摘要

1. 果办和码道是两个独立 OAuth client，各自有独立的 `client_id`、回调地址、authorization code 和 refresh token。
2. 同一个手机号对应同一个华为云 IAM 账号。一次短信验证建立的是 **IAM 登录会话**，不是某个平台的授权码。
3. 在同一个浏览器会话中：
   - 先完成其中一个平台的 OAuth，拿到第一个平台的凭据；
   - 再用同一个会话打开另一个平台的 OAuth，华为云复用 IAM 登录态，第二个平台通常不再要求短信；
   - 第二个平台拿到自己的 authorization code，换取自己的 STS 凭据。
4. 因此可以做到“一次接码、两份凭据”，但**必须保留两个独立的 refresh token**。不要让两个平台共用同一份 STS/refresh token。
5. 已实测成功：果办完成后，码道页面在 **2 秒内自动完成授权**，没有再输入验证码，测试脚本输出 `BOTH_CREDENTIALS_OK`。
6. 已实测失败过的做法：
   - 用默认浏览器测试：浏览器里已有登录态，直接自动登录，不能证明“一次接码”。
   - 隐私窗口里关闭第一个浏览器后再启动第二个：会丢失内存中的 Cookie，第二次不共享会话。
   - 隐私窗口里没有空白锚点标签：第一个授权页成功后自己关闭，整个窗口退出，第二个页面打不开。
7. 当前仓库**两个供应商都有第三入口**，名称都是 **「一次验证码登录两个平台」**：
   - 从果办 OfficeAce 进入：先果办，后码道；
   - 从码道 CodeArts 进入：先码道，后果办；
   - 从哪个入口进入只影响 OAuth 先后顺序，不影响“一次接码、两份凭据”的结果。
8. 实测状态：果办 → 码道方向已完成真实短信验收；码道 → 果办方向已实现并通过单元/本地会话测试，但**尚未做真实短信验收**。实现 Agent 不应把反方向说成已真机验证。

---

## 2. 两个平台的关键参数

| 项目 | 果办 OfficeAce | 码道 CodeArts |
|---|---|---|
| provider id | `officeace` | `codearts` |
| OAuth client_id | `pdp5_for_agentarts` | `codearts-agent` |
| 授权入口 | `https://auth.huaweicloud.com/authui/login.html?...` | `https://codearts.huaweicloud.com/portal/authorize?...` |
| 回调方式 | 云端 CLAW `auth/state` + 轮询 `auth/code` | 本机 `127.0.0.1:<port>/oauth/callback` |
| 换 token | `POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` | 同一个 STS endpoint，但 client_id/redirect 不同 |
| 凭据形态 | `access`、`secret`、`securityToken`、`refreshToken` 等 | `access_key_id`、`secret_access_key`、`security_token`、`refresh_token` 等 |

代码位置：

- 果办 OAuth：`src/login.mjs` 的 `beginLogin()`，大约 185-231 行。
- 码道 OAuth：`src/codearts/index.mjs` 的 `startOAuthFlow()`，大约 939-967 行。
- 当前双平台入口：`index.mjs` 的第三个 auth method，大约 635-781 行。
- 码道记录写入：`src/codearts/index.mjs` 的 `finalizeCodeArtsSignIn()`，大约 4530 行。

---

## 3. 已实测的完整流程

### 3.1 成功流程

```text
用户
  │
  ▼
[1] 创建一次性隔离浏览器 profile（临时 user-data-dir）
  │
  ▼
[2] 打开果办授权页（auth.huaweicloud.com）
  │      同时保留一个 about:blank 空白锚点标签
  ▼
[3] 用户输入手机号，接收并输入一次短信验证码
  │
  ▼
[4] 果办 OAuth 完成，CLAW 轮询拿到 code，换到果办 STS 凭据
  │      第一个浏览器窗口必须保持运行
  ▼
[5] 用同一个 profile 打开码道授权页
  │      不创建新的 profile，不使用默认浏览器
  ▼
[6] 华为云 IAM 复用刚建立的登录会话
  │      码道通常不再发短信
  ▼
[7] 码道本机回调拿到 code，换到码道 STS 凭据
  │
  ▼
[8] 写入两条独立记录：
      果办记录：宿主保存 callback 返回的凭据
      码道记录：finalizeCodeArtsSignIn() 通过 client.auth.set 写入
  │
  ▼
[9] 关闭两个窗口，删除共享临时 profile
```

### 3.2 实测结果

- 测试环境：Windows，Chrome 隐私窗口，一次性临时 profile。
- 测试号码：`150****3411`（报告不记录完整号码）。
- 第一步：果办 OAuth 完成，拿到果办凭据。
- 第二步：同一隐私会话打开码道授权页，**2 秒内完成**，没有再输入验证码。
- 测试脚本输出：

```text
OFFICE_TAB_OPEN
OFFICE_CREDENTIAL_OK
CODEARTS_TAB_OPEN
CODEARTS_CREDENTIAL_OK_SECONDS 2
BOTH_CREDENTIALS_OK
```

- 全程没有打印、保存或写入测试凭据。
- 这是 **果办 → 码道** 方向的实测结论。
- **码道 → 果办** 方向已按同样机制实现，但尚未做真实短信验收；不要把它写成已真机验证。

### 3.3 失败过的测试方式（不要再重复）

| 做法 | 结果 | 原因 |
|---|---|---|
| 用系统默认浏览器打开两个授权页 | 自动登录，测试无效 | 默认浏览器里已有华为云登录态，不能证明只发了一次短信 |
| 隐私窗口只开果办授权页，成功后关闭浏览器，再启动第二个窗口 | 第二个窗口没有共享会话 | 关闭浏览器会丢失内存中的 Cookie；重新启动同一 profile 也不可靠 |
| 隐私窗口只有一个授权标签，没有空白锚点 | 果办页面成功后自己关闭，整个窗口退出 | 没有其他标签撑住浏览器进程，后续无法再开码道 |
| 把同一个 authorization code 提交给两个 OAuth client | 不可行 | code 与 client_id/redirect_uri 绑定，不能跨 client 兑换 |

---

## 4. Cookie/会话共享的关键约束（最重要）

以下三条是实测结论，不是推测：

1. **关闭第一个浏览器后再启动第二个，Cookie 不保证落盘，会话可能丢失。**
2. **第一个浏览器保持运行时，用同一个 `userDataDir` 启动第二个窗口，Cookie 可以共享。**
3. **授权页可能自己调用 `window.close()`；必须额外打开一个 `about:blank` 锚点标签，防止整个窗口退出。**

本地验证结果：

```text
关闭第一个浏览器再启动第二个：cookieShared = false
第一个浏览器保持运行，再启动第二个：cookieShared = true
授权页自动关闭 + 空白锚点标签：cookieShared = true
```

因此实现时必须满足：

- 两次授权使用**同一个临时 profile**（`userDataDir`）。
- 第一次授权结束后**不要关闭第一个浏览器**，直到第二个授权完成。
- 打开授权页时附加一个 `about:blank` 锚点标签。
- 第二个窗口也用同一个 profile，并同样附加锚点标签。
- 全部结束后再关闭窗口、删除临时 profile。
- 不使用用户日常浏览器 profile，不读取用户 Cookie。

---

## 5. 当前仓库实现说明

### 5.1 新增入口

两个供应商的 `auth.methods` 都增加了第三个元素，label 相同：

```js
{
  type: "oauth",
  label: "一次验证码登录两个平台",
  async authorize() { ... },
}
```

- 果办：`index.mjs` 的第三个 auth method。
- 码道：`src/codearts/index.mjs` 的第三个 auth method。

用户入口：

- 华为云 HUAWEI → 果办 OfficeAce → 登录方式 → 「一次验证码登录两个平台」；
- 华为云 HUAWEI → 码道 CodeArts → 登录方式 → 「一次验证码登录两个平台」。

### 5.2 当前实现步骤

**果办入口（先果办、后码道）**

1. 启动果办 `loginMethod.start()`。
2. 启动码道 `startCodeArtsLogin()`（默认使用 `src/codearts/index.mjs` 的 `_internal.startOAuthFlow`）。
3. 用 `launchIsolatedLogin({ url: 果办URL, keepProfile: true, anchorTab: true })` 打开果办窗口。
4. 返回 `{ url: 果办URL, opened: true, callback }`，由宿主等待 callback。
5. callback 中等待果办凭据。
6. 用同一个 `userDataDir` 打开码道窗口（`keepProfile: true, anchorTab: true`）。
7. 等待码道凭据，调用 `finalizeCodeArtsSignIn(client, codeCred, maasFetcher)` 写入码道记录。
8. 返回果办 `successOf(identified)`。
9. finally 中关闭两个窗口、关闭码道回调服务器、删除共享 profile。

**码道入口（先码道、后果办）**

1. 启动码道 `startLoginFlow(fetcher)`。
2. 用 `launchIsolatedLogin({ url: 码道URL, keepProfile: true, anchorTab: true })` 打开码道窗口。
3. 返回 `{ url: 码道URL, opened: true, callback }`，由宿主等待 callback。
4. callback 中等待码道凭据，完成手机号和 MaaS 字段补全，返回码道 `successOf`，并由宿主保存码道记录。
5. 用同一个 `userDataDir` 打开果办窗口（`keepProfile: true, anchorTab: true`）。
6. 等待果办凭据，调用 `finalizeOfficeAceSignIn(client, officeCred, fetcher)` 写入果办记录。
7. finally 中关闭两个窗口、关闭果办轮询、删除共享 profile。

两条流程的共同点：第一个窗口保持运行到第二个窗口打开之后；两个授权页都带 `about:blank` 锚点标签；两份凭据使用各自独立的 refresh token。

### 5.3 隔离浏览器能力

`src/isolated-login.mjs` 已扩展：

- `buildIsolatedArgs({ userDataDir, url, anchorTab })`：`anchorTab` 为真时，在授权 URL 前插入 `about:blank`。
- `launchIsolatedLogin({ userDataDir, keepProfile, anchorTab })`：
  - `userDataDir`：复用已有临时目录，不再 `mkdtemp`。
  - `keepProfile`：关闭窗口时不删除目录。
  - `anchorTab`：额外打开空白锚点标签。
  - `handle.removeProfile()`：显式删除共享目录，幂等。
- 仍拒绝把用户日常浏览器 profile 当临时目录。

### 5.4 两条凭据如何落库

- **从果办入口进入**：
  - 果办：callback 返回 `successOf(identified)`，由 Magpie 宿主保存。
  - 码道：`finalizeCodeArtsSignIn()` 完成手机号和 OfficeAce MaaS 字段补全后，通过 `client.auth.set` 写入一条 `codearts` 记录。
- **从码道入口进入**：
  - 码道：callback 返回 `successOf(withMaas, expires)`，由 Magpie 宿主保存；普通登录路径的 `writeSharedRecord` 继续写入/更新码道记录。
  - 果办：`finalizeOfficeAceSignIn()` 把果办自己的凭据转换成 `officeace` 记录，通过 `client.auth.set` 写入。
- **不共用 refresh token**：两条 OAuth 各自发放独立 refresh token，各自续期。
- **不覆盖已有同身份账号**：如果另一个平台已经有该身份的记录，函数返回 `written:false, reason:"exists"`，当前平台仍成功，日志提示未覆盖。

---

## 6. 给实现 Agent 的硬性约束

### 必须做

- 两次 OAuth 使用同一个临时浏览器 profile。
- 第一次授权完成后保持第一个浏览器运行。
- 两个授权页都加 `about:blank` 锚点标签。
- 第二个授权完成前不要关闭第一个窗口。
- 两条凭据分别保存，各自保留独立 refresh token。
- 第二个平台失败或超时，不要推翻已成功的第一个平台凭据。
- 结束时关闭窗口并删除临时 profile。
- 日志只写状态，不写 access、secret、securityToken、refresh token、完整授权 URL。

### 禁止做

- 禁止用同一个 authorization code 兑换两个平台的 token。
- 禁止把一份 STS/refresh token 同时写进两个平台记录。
- 禁止用默认浏览器或用户日常 profile 冒充“隐私会话”。
- 禁止在第一个窗口关闭后再启动第二个窗口，然后声称会话共享成功。
- 禁止在未做真实短信验收时声称“码道 → 果办”反方向已真机验证。
- 禁止覆盖已有同身份账号而不告知用户。

### 已知限制

- 当前真实短信实测只覆盖 **果办 → 码道** 方向；**码道 → 果办** 已实现并通过单元测试、本地 profile 共享测试，但尚未做真实短信验收。
- 果办入口的码道 OAuth 在 `authorize()` 阶段就启动；如果用户在果办页面停留超过码道回调有效期，码道可能需要重新开始。当前实现会记录失败并保留果办成功。码道入口的果办 OAuth 在码道成功后才启动，不受这个先后耦合影响。
- 用户手动关闭第一个窗口会导致共享会话丢失，第二个平台可能重新要求短信。
- 另一个平台已存在同身份记录时不会更新旧凭据，只会记录 `exists`。
- 码道回调依赖本机 `127.0.0.1`，远程 Magpie Web 场景需要单独验证。

---

## 7. 测试与验收

### 7.1 自动化测试

```powershell
cd D:\project_GIT\test\20261113\magpie-officeace
npm test
npm run check:ua
node --check index.mjs
node --check src/isolated-login.mjs
node --check src/codearts/index.mjs
```

当前结果：

- `npm test`：361 项全部通过。
- `npm run check:ua`：退出码 0；保留仓库原有的两条 UA 警告。
- 语法检查：通过。
- 入口 label 验证：

```text
officeace: 华为云账号 | 添加其他华为云账号 | 一次验证码登录两个平台
codearts: Sign in with Huawei Cloud | 一次验证码登录两个平台
```

重点测试文件：

- `tests/dual-login.test.mjs`：两个方向共 12 条。果办入口覆盖成功、码道超时、码道失败、第一窗口失败、同身份已存在、果办失败释放资源；码道入口覆盖成功、果办超时、果办启动失败、果办同身份已存在、码道失败、第一窗口失败。
- `tests/isolated-login.test.mjs`：共享 profile、`keepProfile`、`removeProfile`、日常 profile 保护、锚点标签参数。
- `tests/maas.test.mjs`：果办第三个登录入口的声明。
- `tests/codearts.test.mjs`：码道第二个登录入口的声明。

### 7.2 真实环境验收步骤

1. 完全退出并重新启动 Magpie，确保加载最新插件代码。
2. 打开华为云 HUAWEI 插件 → 果办 OfficeAce 或 码道 CodeArts → 登录方式。
3. 选择「一次验证码登录两个平台」。两个供应商都有这个入口，从哪个进入都可以。
4. 在打开的隔离窗口里完成**一次**手机号短信验证。
5. 不要手动关闭窗口；等待插件自动打开另一个平台的授权页。
6. 如果第二个平台页面没有要求再次输入验证码并自动完成，验收通过。
7. 检查 Magpie 中果办和码道两个供应商都出现该账号。
8. 检查插件日志：
   - 果办入口应出现「果办与码道两个平台已使用同一次验证码完成登录」；
   - 码道入口应出现「码道与果办两个平台已使用同一次验证码完成登录」。

### 7.3 失败判定

| 现象 | 判定 | 处理 |
|---|---|---|
| 第二个页面要求再次短信 | 会话没有共享，不能算一次接码 | 检查是否同一 profile、第一个窗口是否被关闭、是否有锚点标签 |
| 第二个窗口没有打开 | 隔离窗口启动失败 | 检查浏览器路径、profile 锁、`openIsolated` 返回值 |
| 只出现第一个平台账号 | 第二个平台记录写入失败或被判定已存在 | 果办入口查 `finalizeCodeArtsSignIn`；码道入口查 `finalizeOfficeAceSignIn`；再看 `client.auth.set` 和日志 `reason` |
| 日志出现 `reason:"exists"` | 第二个平台已有同身份账号 | 不覆盖是预期行为；如需更新，另行设计安全的 key 查找 |
| 第二个平台授权超时 | 第一个平台仍然成功 | 第二个平台可单独登录；不要把第一个平台改成失败 |

---

## 8. 实现顺序建议

如果另一个 Agent 要从零实现，建议按以下顺序：

1. 先实现/验证“同一 profile、第一个窗口不关闭、第二个窗口共享 Cookie”的最小浏览器实验。
2. 再加入果办 OAuth（`beginLogin`）。
3. 再加入码道 OAuth（`startOAuthFlow`）。
4. 再加入 `about:blank` 锚点标签，验证授权页自动关闭时浏览器不退出。
5. 再加入两条凭据写入，确保 refresh token 不共享。
6. 先实现一个方向（例如果办 → 码道），再把同样的机制复制到另一个供应商入口（码道 → 果办）。
7. 最后补错误处理和测试：第二个平台失败不能影响第一个平台成功。

不要先写 UI 或先写双写记录；最容易出错的是浏览器会话生命周期。两个入口的核心机制相同，只有“谁先授权、最后写哪条兄弟记录”不同。

---

## 9. 证据与文件索引

| 内容 | 位置 |
|---|---|
| 果办侧双平台入口 | `index.mjs` 约 635-781 行 |
| 码道侧双平台入口 | `src/codearts/index.mjs` 约 3612-3730 行 |
| 果办 OAuth | `src/login.mjs` 约 185-231 行 |
| 码道 OAuth | `src/codearts/index.mjs` 约 939-967 行 |
| 码道记录写入（果办入口用） | `src/codearts/index.mjs` 的 `finalizeCodeArtsSignIn()`，约 4655 行 |
| 果办记录写入（码道入口用） | `src/codearts/index.mjs` 的 `finalizeOfficeAceSignIn()`，约 4669 行 |
| 隔离浏览器共享 profile | `src/isolated-login.mjs` 约 167、213、291 行 |
| 双平台测试（两个方向） | `tests/dual-login.test.mjs`，12 条 |
| 入口声明测试 | `tests/maas.test.mjs`、`tests/codearts.test.mjs` |
| 隔离浏览器测试 | `tests/isolated-login.test.mjs` |

本报告不包含任何真实 access、secret、securityToken、refresh token 或完整手机号。真实测试凭据已在测试脚本结束时丢弃，未写入仓库。
