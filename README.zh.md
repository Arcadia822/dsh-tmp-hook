# dsh-tmp-hook

[English](README.md) | 中文

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（dsh）会话用的**单次临时 Webhook**。

dsh 里的协调 Agent 常把工作分派给外部、沙盒化或长时运行的 Worker（容器、远端主机、另一个 AgentOS 运行时）。Worker 干完后得通知协调者——既不想挂常驻 WebSocket，也不想轮询。

`dsh-tmp-hook` 给 Agent 注入 `request_tmp_hook` 工具：调用后返回一个**绑定当前会话、带 TTL、只能用一次**的 HTTPS 回调地址。Worker 把结果 POST 上去一次，载荷就作为 user 消息追加进发起会话，Agent 立即被唤醒。之后这个地址即失效：再 POST 返回 `410`。

```
协调 Agent ──request_tmp_hook──▶ https://dsh.example.com/api/tmp-hooks/<token>
    │
    │  （把地址交给沙盒 Worker）
    ▼
Worker ──POST {"status":"done",...}──▶ dsh-tmp-hook ──sessionController.prompt()──▶ 协调 Agent 被唤醒
```

## 安装

```bash
dsh plugin --profile web add dsh-tmp-hook
```

`dsh plugin add` 会为声明了 `dsh.bundle.patch` 的包自动维护 `dsh.profile.bundles`，插件行无需手改。配置写在 profile 自己的 patch 层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`，它在所有 bundle 层之后应用）：

```yaml
- id: tmp-hook
  config:
    baseUrl: https://dsh.example.com
```

通常只需要设 `baseUrl`——外部 Worker 要调的公网源站。没设之前 `request_tmp_hook` 会**明确报错**，而不是发一个谁都到不了的 URL。

从源码目录试装：

```bash
dsh plugin --profile web add /path/to/dsh-tmp-hook
```

## 配置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `baseUrl` | `''` | 回调 URL 的公网源站，必须是绝对 `http`/`https` URL，尾部斜杠会被去掉。空 = 未配置。 |
| `pathPrefix` | `'/api/tmp-hooks'` | 回调路由的路径前缀。必须是子路径，`/` 会被拒绝。 |
| `ttlSeconds` | `1800` | 工具调用未传 `ttl_seconds` 时的默认有效期。 |
| `minTtlSeconds` | `30` | `ttl_seconds` 下限。 |
| `maxTtlSeconds` | `86400` | `ttl_seconds` 上限。 |
| `maxBodyBytes` | `262144` | 回调请求体上限，超出返回 `413`。 |
| `sweepIntervalMs` | `60000` | 过期 token 清扫周期；`0` 关闭清扫器（则仅在访问时回收）。 |
| `deliverTimeoutMs` | `15000` | 把消息投递进会话的预算。 |
| `allowUnauthenticated` | `true` | 与 `dsh-auth-gate` 组合，使回调前缀无需登录态即可到达。见下文。 |

未知键与非法值在**加载期**就被拒绝：配置写错会导致启动失败，而不是第一次回调时才失败。

## Agent 工具：`request_tmp_hook`

参数（都可选）：

- `purpose` — 简述这次等待的是什么工作。回调触发时会一并带回，便于一个会话同时等多个回调时区分。
- `ttl_seconds` — 有效期，会被夹到 `[minTtlSeconds, maxTtlSeconds]`。

返回 `url`、`token`、`session_id`、`expires_at`、`expires_in_seconds`——把 `url` 交给外部 Worker 即可，别的都不用给。

## HTTP 契约

`POST <baseUrl><pathPrefix>/<token>`，请求体可选，内容任意。

| 情况 | 状态码 | 响应体 |
| --- | --- | --- |
| 投递成功 | `200` | `{"received":true}` |
| token 不存在 | `404` | `{"received":false,"error":"unknown token"}` |
| 已过 TTL | `410` | `{"received":false,"error":"token expired"}` |
| 已投递过 | `410` | `{"received":false,"error":"token already used"}` |
| 非 `POST` | `405` | `{"received":false,"error":"method not allowed"}`（带 `Allow: POST`） |
| 请求体超过 `maxBodyBytes` | `413` | `{"received":false,"error":"payload too large"}` |
| 请求体读取失败 | `400` | `{"received":false,"error":"request aborted"}` |
| 会话投递失败 | `502` | `{"received":false,"error":"delivery failed"}` |

`200` 只代表消息已进入会话收件箱，**不代表 Agent 那一轮跑完了**：模型再慢也不会拖住 Worker。

任何发生在"消息已投递"之前的失败（`400`/`413`/`502`）都会**释放** token，所以超大上传或宿主的瞬时故障不会烧掉 Worker 唯一那次通知机会。只有真正投递成功的 token 才会被消耗。

### 载荷

请求体不要求是 JSON：

- 空 body → 投递为 `(empty)`；
- 合法 JSON → pretty-print 后投递；裸 JSON 字符串（`"done"`）投递为 `done`；
- 其余一切 → 原文投递。

请求声明的 `Content-Type` 会一并写进投递消息作为上下文。回调体经常不是 JSON——构建日志尾巴、Worker stdout、`curl --data-raw` 的字符串——所以**不会因为形状不对而拒绝任何请求体**。

## 投递到会话的消息

```
[dsh-tmp-hook] One-time callback received at 2026-09-18T11:02:21.513Z.
Token: 523a6527-77f0-44c2-b2fc-db7b9cf36a6a
Purpose: e2e-verify
Content-Type: application/json

Payload:
{
  "status": "done",
  "spec_url": "https://taco.example/spec/42"
}
```

非 JSON 的 body 形状相同，只是把 pretty-print 的 JSON 换成原文：

```
[dsh-tmp-hook] One-time callback received at 2026-09-18T11:04:02.171Z.
Token: 6dbe29f9-263e-4234-a1e9-ed1919750f99
Purpose: build finished
Content-Type: text/plain; charset=utf-8

Payload:
build 42 finished
all green
```

渲染有上限（64 KiB），避免超大载荷灌爆上下文窗口。

## 认证

回调 URL 本身就是**能力凭证（capability）**：token 是随机 UUID，也是外部 Worker 唯一需要的凭据。部署的其他部分都不必暴露。

默认（`allowUnauthenticated: true`）下，若装有 [dsh-auth-gate](https://github.com/TecFancy/dsh-auth-gate)，插件会与之组合：该插件把 `AuthService.gate` 标注为**可写**、且守卫按请求解析 gate，因此本插件叠加一个委托 gate——只放行自己的路径前缀，其余判定全部转交原 gate。除此之外没有任何路径会绕过登录。没有认证插件时该组合会被跳过，插件卸载时会还原。

设 `allowUnauthenticated: false` 可让整个控制台都留在认证门后——此时回调前缀需要自己独立的入口规则（例如一条指向 dsh 端口的 nginx `location`，或单独的反代），认证插件根本看不到回调请求。

限流、TLS、DNS、反代配置属部署层，本插件刻意不涉及。

## 范围与限制

- token 存在 dsh 进程内存里。进程重启后所有已发出的回调 URL 失效，Worker 再 POST 会得到 `404`，协调者需要重新申请。
- 插件是 host-only：没有浏览器半边、没有设置页、没有 UI。
- 除 Node 标准库外**不 import 任何东西**。只组合 `webServer`、`tools`、`sessionController` 三个宿主服务，因此可以直接装进任何 profile，不会引入第二份宿主依赖。

## 开发

```bash
node --test test/*.test.js
```

测试覆盖 token 表（单次、过期、claim/release、清扫）、HTTP 处理器（上表每个状态码、并发、载荷渲染）、配置校验与工具契约。

插件已在真实 dsh web profile 上端到端验证过（`@deepseek-ai/dsh` `0.1.5-rc.1` + `dsh-auth-gate` password 模式）：Agent 调用 `request_tmp_hook`，对返回 URL 的**未认证** POST 被投递进会话并触发 Agent 下一轮；重放、过期、`405`、`400`、`413`、`502` 逐条在运行中的服务上跑过；JSON 与 `text/plain` 两种载荷都核对了持久化会话日志中的原文。

## License

MIT
