# dsh-tmp-hook

English | [中文](README.zh.md)

One-time ephemeral webhooks for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) sessions.

A coordinator agent running in dsh often dispatches work to an external, sandboxed, or
long-running worker (a container, a remote host, another AgentOS runtime). When the worker
finishes, it has to tell the coordinator — without a resident WebSocket and without the
coordinator polling.

`dsh-tmp-hook` gives the agent the `request_tmp_hook` tool. The call returns a
single-use, TTL-bounded HTTPS URL bound to that session. The worker POSTs its result JSON
to the URL once; the payload is appended to the requesting session as a user message and
the agent wakes immediately. The URL is dead after that: a second POST returns `410`.

```
coordinator ──request_tmp_hook──▶ https://dsh.example.com/api/tmp-hooks/<token>
    │
    │  (hands the URL to the sandboxed worker)
    ▼
worker ──POST {"status":"done","url":"…"}──▶ dsh-tmp-hook ──sessionController.prompt()──▶ coordinator wakes
```

## Install

```bash
dsh plugin --profile web add dsh-tmp-hook
```

`dsh plugin add` reconciles `dsh.profile.bundles` for packages that declare
`dsh.bundle.patch`, so the plugin row is registered automatically. Configure it in the
profile's own patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), which is applied
after every bundle layer:

```yaml
- id: tmp-hook
  config:
    baseUrl: https://dsh.example.com   # optional: overrides the derived origin
```

`baseUrl` is the public origin the external worker will call. You usually do not have to set
it: a console served behind a reverse proxy must already declare its public domain with
`--trusted-host <domain>` or the browser-trust fence rejects it, and the plugin derives the
origin from that same declaration. Set `baseUrl` explicitly when the deployment declares no
port-less domain (an IP-only or loopback-only bind), or to override the derived scheme.

With neither an explicit `baseUrl` nor a usable declaration, `request_tmp_hook` fails loudly
rather than handing a worker a URL nobody can reach.

To try it from a checkout instead of the registry:

```bash
dsh plugin --profile web add /path/to/dsh-tmp-hook
```

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `baseUrl` | `''` | Public origin prepended to every callback URL. Must be an absolute `http`/`https` URL; trailing slashes are stripped. Empty means "derive it from the trust fence". |
| `baseUrlScheme` | `'https'` | Scheme assumed for a derived origin. Ignored when `baseUrl` is set. |
| `pathPrefix` | `'/api/tmp-hooks'` | Path prefix the callback route is registered under. Must be a sub-path; `/` is rejected. |
| `ttlSeconds` | `1800` | Default token lifetime when the tool call omits `ttl_seconds`. |
| `minTtlSeconds` | `30` | Lower clamp for a requested `ttl_seconds`. |
| `maxTtlSeconds` | `86400` | Upper clamp for a requested `ttl_seconds`. |
| `maxBodyBytes` | `262144` | Maximum accepted callback body. Larger bodies get `413`. |
| `sweepIntervalMs` | `60000` | Period between expired-token sweeps. `0` disables the sweeper (records then only die on access). |
| `deliverTimeoutMs` | `15000` | Budget for admitting a delivered message into its session. |
| `allowUnauthenticated` | `true` | Compose with `dsh-auth-gate` so the callback prefix is reachable without a dsh login session. See below. |

Unknown keys and malformed values are rejected at load time: a bad config fails the boot
instead of failing the first callback.

## Agent tool: `request_tmp_hook`

The description the model sees states when to reach for the tool: **before handing work to
anything that finishes after the current turn** and cannot be awaited in place — a sandboxed
or remote worker, a container or AgentOS task, a CI job, a long-running script, a dispatched
agent, or a human replying out of band. It also states when not to: work that completes
inside this turn, a result you will poll for anyway, or a channel the worker already holds.
The model is told to pass the URL to the worker as part of the task and to record enough
detail in `purpose` to recognize which awaited completion fired.

Arguments (both optional):

- `purpose` — short description of the work being awaited. Echoed back in the delivered
  message so a session waiting on several callbacks can tell them apart.
- `ttl_seconds` — lifetime, clamped to `[minTtlSeconds, maxTtlSeconds]`.

Result (`url`, `token`, `session_id`, `expires_at`, `expires_in_seconds`) — hand `url` to
the external worker and nothing else.

## HTTP contract

`POST <baseUrl><pathPrefix>/<token>`. The body is optional and may be anything.

| condition | status | body |
| --- | --- | --- |
| delivered | `200` | `{"received":true}` |
| unknown token | `404` | `{"received":false,"error":"unknown token"}` |
| TTL elapsed | `410` | `{"received":false,"error":"token expired"}` |
| already delivered | `410` | `{"received":false,"error":"token already used"}` |
| method is not `POST` | `405` | `{"received":false,"error":"method not allowed"}` (`Allow: POST`) |
| body over `maxBodyBytes` | `413` | `{"received":false,"error":"payload too large"}` |
| body could not be read | `400` | `{"received":false,"error":"request aborted"}` |
| session admission failed | `502` | `{"received":false,"error":"delivery failed"}` |

The response acknowledges admission into the session inbox, not the agent's turn: a slow
model never delays the worker.

Any failure **before** a message was admitted releases the token again (`400`, `413`, `502`),
so an oversized upload or a transient host error does not burn the worker's one
notification. A token is only consumed by a delivery that succeeded.

### Payload

The body is not required to be JSON:

- empty body → delivered as `(empty)`;
- valid JSON → delivered pretty-printed, except a bare JSON string (`"done"`), which is
  delivered as `done`;
- anything else → delivered verbatim.

The request's `Content-Type` is echoed into the delivered message as context. Because
callback bodies are frequently not JSON — a build log tail, a worker's stdout, a curl
`--data-raw` string — a body is never rejected for its shape.

## Delivered message

The payload arrives in the session as a user message:

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

A non-JSON body renders the same way, with its text in place of the pretty-printed JSON:

```
[dsh-tmp-hook] One-time callback received at 2026-09-18T11:04:02.171Z.
Token: 6dbe29f9-263e-4234-a1e9-ed1919750f99
Purpose: build finished
Content-Type: text/plain; charset=utf-8

Payload:
build 42 finished
all green
```

Rendering is bounded (64 KiB) so an oversized payload cannot flood the context window.

## Authentication

The callback URL is a **capability**: the token is a random UUID and is the only
credential the external worker needs. Nothing else about the deployment has to be exposed.

By default (`allowUnauthenticated: true`) the plugin composes with
[dsh-auth-gate](https://github.com/TecFancy/dsh-auth-gate) when it is installed: the auth
plugin's `AuthService.gate` field is documented as writable and its guard resolves the gate
per request, so the plugin overlays a delegating gate that allows exactly its own path
prefix and forwards every other decision to the original gate. Nothing else becomes
reachable without a login. The composition is skipped when no auth plugin is present, and
restored when the plugin unloads.

Set `allowUnauthenticated: false` to keep the whole console behind the auth gate — the
callback prefix then needs its own ingress rule (an nginx `location` pointed at the dsh
port, or a separate proxy), in which case the auth plugin never sees the callback request.

Rate limiting, TLS, DNS, and reverse-proxy configuration are deployment concerns and are
deliberately out of scope for this plugin.

## Scope and limits

- Tokens live in the dsh process. A restart invalidates every outstanding callback URL;
  the worker's POST then returns `404` and the coordinator has to mint a new hook.
- The origin is derived from the deployment's own `--trusted-host` declarations, never from
  a request `Host` header. A Host header is attacker-controlled, so trusting the last-seen
  one would let anyone who can reach the console poison every future callback URL; an
  underivable origin fails loudly instead.
- The plugin is host-only: no browser half, no settings page, no UI.
- The plugin imports nothing outside Node's standard library. It composes only the
  `webServer`, `tools`, and `sessionController` harness services, so it drops into any
  profile without installing a second copy of the harness packages.

## Development

```bash
node --test test/*.test.js
```

The suite covers the token store (single use, expiry, claim/release, sweep), the HTTP
handler (every status above, concurrency, payload rendering), config validation, and the
tool contract.

The plugin was verified end to end against a live dsh web profile (`@deepseek-ai/dsh`
`0.1.5-rc.1`, `dsh-auth-gate` password mode): the agent called `request_tmp_hook`, an
unauthenticated POST on the returned URL was delivered into the session and produced the
agent's next turn, and replay, expiry, `405`, `400`, `413`, and `502` were each exercised
against the running server.
