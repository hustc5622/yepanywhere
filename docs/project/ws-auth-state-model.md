# WebSocket 认证状态模型

本文定义服务端 WebSocket connection 的认证模型。目标是把 HTTP/cookie trust 和 SRP transport key state 明确分开。

## 核心概念

这里独立跟踪三类关注点。

1. **HTTP auth context（upgrade request context）**

- 示例：cookie middleware 提供的 `authenticatedViaSession`。
- 回答的问题：这次 HTTP upgrade request 是否已经带有有效 session cookie？

2. **WebSocket admission policy（`connectionPolicy`）**

- `local_unrestricted`
- `local_cookie_trusted`
- `srp_required`
- 回答的问题：这条 connection 是否需要 SRP transport auth？
- 来源：`packages/server/src/routes/ws-auth-policy.ts`

3. **SRP transport auth state（`authState` + `sessionKey`）**

- `authState`：`unauthenticated` | `srp_waiting_proof` | `authenticated`
- `sessionKey`：仅在 SRP 成功或 resume 成功后存在。
- 回答的问题：是否已经真正建立了 SRP transport key？
- 来源：`packages/server/src/routes/ws-transport-auth.ts`

相关 enforcement flag：

- `requiresEncryptedMessages`：只对已建立 SRP 的 connection 为 true。

## 标准场景

| 场景 | Entry path | `connectionPolicy` | 初始 `authState` | `sessionKey` | `requiresEncryptedMessages` |
|------|------------|--------------------|-------------------|--------------|-----------------------------|
| Localhost/LAN，remote access disabled | `createWsRelayRoutes` | `local_unrestricted` | `authenticated` | none | false |
| Localhost/LAN，remote access enabled，有效 session cookie | `createWsRelayRoutes` | `local_cookie_trusted` | `authenticated` | none | false |
| Localhost/LAN，remote access enabled，无 cookie | `createWsRelayRoutes` | `srp_required` | `unauthenticated` | none | false |
| Direct encrypted WS（SecureConnection，无 relay） | `createWsRelayRoutes` | `srp_required` | `unauthenticated` | after SRP | true after SRP |
| Relay encrypted WS | `createAcceptRelayConnection` | `srp_required` | `unauthenticated` | after SRP | true after SRP |

说明：

- Relay 永远以 `srp_required` 开始（`packages/server/src/routes/ws-relay.ts`）。
- Local trusted path 只有在 policy 可信时，才会在没有 SRP key 的情况下设置 `authState = "authenticated"`。

## SRP Required Flow

当 `connectionPolicy = "srp_required"`：

1. 初始状态：`authState = "unauthenticated"`，`sessionKey = null`
2. 接受 `srp_hello`：
   - `authState = "srp_waiting_proof"`
3. `srp_proof` 成功或 `srp_resume` 成功：
   - `authState = "authenticated"`
   - `sessionKey = <32-byte key>`
   - `requiresEncryptedMessages = true`
4. 认证后的消息规则：
   - 拒绝 plaintext（`4005`）
   - 必须使用 encrypted envelopes

## Trusted Local Flow（无需 SRP）

对于 `local_unrestricted` 或 `local_cookie_trusted`：

1. 打开 connection：
   - `authState = "authenticated"`
   - `sessionKey = null`
   - `requiresEncryptedMessages = false`
2. 允许 plaintext request/subscribe/upload messages。
3. 通过 `shouldMarkInternalWsAuthenticated(...)`，这条 connection 在 routed app requests 中被视为内部已认证。

## 不变量

1. `hasEstablishedSrpTransport(...)` 只有在以下条件成立时才为 true：
   - `authState === "authenticated"` 且 `sessionKey != null`

2. Trusted local auth（`local_*`）和 SRP transport auth 是不同概念：
   - Trusted local 可以 authenticated 但没有 key。
   - SRP-established auth 必然有 key。

3. 两阶段 resume 的 replay protection 必须保留：
   - `srp_resume_init` 发出 server nonce challenge。
   - `srp_resume` proof 绑定 challenge，且只能使用一次。

## 关键代码引用

- Policy derivation：`packages/server/src/routes/ws-auth-policy.ts`
- Transport auth helpers：`packages/server/src/routes/ws-transport-auth.ts`
- Direct + relay entry points：`packages/server/src/routes/ws-relay.ts`
- SRP handshake/resume handlers：`packages/server/src/routes/ws-srp-handlers.ts`
- Transport auth message policy checks：`packages/server/src/routes/ws-transport-message-auth.ts`
- Frame decode + dispatch：`packages/server/src/routes/ws-message-router.ts`
