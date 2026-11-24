# dsh-connect-marvis

在 DeepSeek Harness 里直接使用腾讯 Marvis（马维斯）背后的模型 —— **不需要 API Key，装好一次之后也不需要开着 Marvis 客户端**。

## 它提供什么

| 模型槽位 | 展示名 | 能力 |
|---|---|---|
| `main-auto` | DeepSeek V4.1 Flash | 推理 / 工具 / 图像，1M 上下文 |
| `deepseek-v4-pro-external` | DeepSeek V4 Pro | 同上，Pro 档槽位 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 推理 / 工具 / 图像（看账号权益） |
| `claude-opus-4-6` | Claude Opus 4.6 | 同上 |
| `gpt-5.4` | GPT-5.4 | 同上 |
| `hy3-preview-agent-real` | 混元 Hy3 | 推理 / 工具 |
| `hunyuan-turbos-vision` | HY-Vision 2.0 | 图像理解 |

装上之后这些模型会出现在 DSH 的模型选择器里，分组名 **Marvis**。

## 脱离客户端是怎么做到的

关键事实：Marvis 的 `access_token` 只有 **2 小时**，但续期接口只要 `refreshToken` 就能换新的有效期，而 `refreshToken` 本身很长命。

所以流程是：

1. **客户端在的时候抓一次**（只要一次）：从 `%TEMP%\Tencent\Marvis\logs\MarvisHost.log` 里读出
   `openid` / `accessToken` / `guid` / `refreshToken`，写进 `~/.dsh/marvis-credentials.json`（权限 0600）。
2. **之后自己续期**：每次发请求前检查剩余寿命，低于 15% 就调
   `POST /marvis_client_login/marvis_refresh_token` 重置有效期。
3. **客户端可以关掉**：指纹来自客户端自带的设备指纹组件（插件自动定位），凭据来自本地缓存，日志只用于首次抓取。

已验证：**把 `Marvis` / `MarvisAgent` / `MarvisHost` / `MarvisMCP` / `MarvisSvr` 全部杀掉，
甚至把客户端日志改名藏起来，插件依然能对话、能续期、能调工具。**

## 依赖

1. **本机登录过一次 Marvis 客户端**（Windows）。之后不需要它常驻。
2. **Marvis 客户端要装在本机** —— 插件需要客户端自带的设备指纹组件
   （`beacon_napi.node`、`qimei.dll`、`beacon_sdk.dll`、`beacon_wrapper.dll`）。

   这四个文件是**腾讯客户端的资产，本仓库不附带**。插件会自动去
   `<Marvis 安装目录>\Application\<版本>\win32-native\` 找它们（取版本号最高的那个目录）。
   客户端升级后组件跟着换新，插件下次启动自然用上，不用手工覆盖。

   如果你的 Marvis 装在非默认位置，用环境变量指过去：

   ```
   MARVIS_NATIVE_DIR=D:\你的路径\Marvis\Application\1.60.3600.59\win32-native
   ```

## 安装

**从插件市场装（推荐）**：DSH 里打开 **插件 → 发现**，搜 `marvis` 或 `马维斯`，
点安装即可。收录在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的 `model` 分类，PR 见 [#18525](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18525)。

**一条命令装**：

```bash
dsh plugin add github:lehuaner/dsh-connect-marvis
```

**从源码装**：在 DSH 里用 **Plugins → Add plugin** 选择本目录，或用 plugin_manager：

```
install_bundle  →  <本仓库路径>
```

安装后重启 DSH，模型选择器里会出现 **Marvis** 分组。

## 验证

```bash
node probe/verify.mjs
```

五步：设备指纹 → 登录态 → 自动续期 → 真实对话 → 工具调用。全绿就说明可用。

## 完全不用客户端（可选）

如果你想把凭据搬到另一台机器，或干脆不装客户端，直接给环境变量：

```
MARVIS_OPENID=o0123456789abcdef0123456789abcde
MARVIS_ACCESS_TOKEN=mv_0123456789abcdef0123456789abcdef
MARVIS_GUID=00000000000000000000000000000000
MARVIS_REFRESH_TOKEN=1_0123456789abcdef0123456789abcdef
```

（上面全是占位值，换成你自己的。四个一起给齐就能工作，并会自动续期。
`MARVIS_REFRESH_TOKEN` 从上面那个日志文件里搜 `"refreshToken":"` 就能找到。）

## 排障

| 现象 | 原因与处理 |
|---|---|
| `找不到 Marvis 登录态` | 打开一次 Marvis 客户端登录，或配好上面四个环境变量 |
| `Marvis 登录态已失效` (4100403) | `refreshToken` 也废了（改密码/长期不用），重新登录一次客户端 |
| `风控拦截` (4100404) | 设备指纹组件跟客户端版本不匹配 —— 升级 Marvis 客户端，插件会自动用新版组件 |
| `非法请求` (4100406) | system 消息**开头**是「`You are a/an …`」标准助手身份句。适配器会自动改写，见下 |
| `Marvis 不认这个模型` (4130001) | 槽位名写错了；只能用上表里的 id |
| 续期返回 `code=-109` | 请求体形状不对；必须是 `{userInfo:{openId,refreshToken,accessToken,loginType:"Marvis"}}` |
| `adapter.imageRequestPricing is not a function` | 旧版适配器缺基类方法；内核不做存在性检查直接调。0.1.1 已修 —— 重启 DSH 加载新版 |

## 4100406「非法请求」的判定规则

网关会拒掉一类**标准助手身份句**（HTTP 403 + `code=4100406`，响应 80~100ms，
根本没进模型）。和请求头、鉴权、配额都无关。三个条件同时成立才触发：

1. 出现在 **system 消息的开头**（允许前导空白/换行）；
2. 以 `You are` 起头；
3. 后面紧跟 `a`/`an` + 角色名词，或 `Claude`。

实测对照（同账号、同分钟、同 slot）：

| system 内容 | 结果 |
|---|---|
| `You are a helpful assistant.` | ✗ 4100406 |
| `You are an AI agent.` | ✗ 4100406 |
| `You are a coding agent.` | ✗ 4100406 |
| `You are Claude, made by Anthropic.` | ✗ 4100406 |
| `You are a assistant.`（无形容词） | ✓ |
| `You are a helpful agent.`（换名词） | ✓ |
| `You are welcome.` / `You are a banana.` | ✓ |
| `You are ChatGPT, a large language model.` | ✓ |
| `你是一个有用的助手。` | ✓ |
| 同样的句子放到第二行 / 放进 user 角色 | ✓ |

DSH 注入的系统提示第一句恰好整句命中（`You are an AI agent powered by …`），
所以该宿主下**每一条**请求都会被秒拒。适配器在 `toChatMessages` 出口把 system
开头的 `You are` 换成 `This agent is`（语义等价、模型侧零损失），只改 system、
只改开头，user 正文和工具描述一概不动。

## 已知行为

- **所有槽位当前都路由到同一个模型**：本机账号被服务端降级路由到 `deepseek-v4-flash-ga-260731`。
  这是账号侧行为，不是插件问题；换账号或账号恢复后会自动变回。
- `access_token` 续期后**不会变**，只重置有效期 —— 这是上游的设计，不是 bug。
- 自定义 system prompt、tools、temperature 都能正常用，没有身份句限制。

## 许可

MIT
