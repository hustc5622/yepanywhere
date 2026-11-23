# 公网安全访问与端到端 TLS 配置指南

本文面向通过 **国内高速 TCP frp 隧道**（例如 `39.106.189.88:18022`）或海外节点访问 Yep Anywhere 的自托管部署，兼顾 **国内低延迟、端到端 TLS 1.3 加密、以及日常无感登录体验**。

## 架构概览

Yep Anywhere 支持**双端口并行监听**：
- **主 HTTP 端口（如 `127.0.0.1:8022`）**：保持不变，继续服务本机脚本、`deploy.sh`、`hot-apply`、`FeishuChannelRuntime` 与 `cloudflared`（`https://air.yueyuan.uk`）。
- **独立端到端 TLS 端口（如 `127.0.0.1:8443`）**：通过 `TLS_PORT=8443` 开启，供 `frpc` 的 TCP 隧道直接透传 TLS 1.3 密文。TLS 终结在你的 Mac 本机，**第三方 frp 服务商也无法解密任何流量、Cookie、代码或终端输出**，且支持证书文件变更自动热重载（无需重启服务）。

> [!WARNING]
> **切勿按 `127.0.0.1` 做本机免密放行**：由于 `frpc` 运行在本机并将公网流量转发到 `127.0.0.1`，公网请求到达 Node.js 时的 TCP 源地址同样是 `127.0.0.1`。公网开放前务必在「设置 → 本地访问」开启密码认证。

---

## 路径 1：国内 TCP frp 纯 IP 端到端 TLS 1.3（绕开未备案域名 SNI 拦截）

国内阿里云等机房的 TCP 节点通常会拦截未备案域名的 TLS SNI，但对**纯 IP HTTPS**（RFC 6066 规定不发送域名 SNI）100% 放行。通过自建一次 10 年期私有根 CA 签发包含公网 IP SAN 的服务端证书，即可同时获得 **国内 ~40ms 满速 + 浏览器绿锁 + 端到端 TLS 1.3**。

### 1. 生成私有根 CA 与 IP 服务端证书

```bash
scripts/setup-private-tls.sh --ip 39.106.189.88 --ip 47.95.254.240
```

产出位于 `~/.yep-anywhere/tls/`：
- `yep-root-ca.crt`：10 年期私有根 CA（在各终端信任一次即可；日后若更换 frp IP，重跑脚本只会复用根 CA 并重签 `server.crt`，终端无需重新安装 CA）。
- `server.crt` / `server.key`：服务端叶子证书与私钥（热重载监听会自动加载替换后的新证书）。

### 2. 配置 Yep 启动环境变量（`.env.deploy.local`）

```bash
TLS_PORT=8443
TLS_CERT_PATH=/Users/<你的用户名>/.yep-anywhere/tls/server.crt
TLS_KEY_PATH=/Users/<你的用户名>/.yep-anywhere/tls/server.key
ALLOWED_HOSTS=39.106.189.88,47.95.254.240,air.yueyuan.uk
```

部署生效（需要一次正常重启窗口）：
```bash
scripts/deploy.sh --server-only
```

### 3. 将 `frpc` 隧道指向 `8443`

将 `/opt/homebrew/etc/frp/frpc-tcp1.toml` 中 Yep 隧道的 `localPort` 从 `8022` 改为 `8443` 并重载 `frpc`，即可通过 `https://39.106.189.88:18022/yep` 访问。

### 4. 各终端一次性信任根 CA

- **macOS**：
  ```bash
  sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain ~/.yep-anywhere/tls/yep-root-ca.crt
  ```
- **iPhone / iPad**：将 `yep-root-ca.crt` 隔空投送（AirDrop）到手机 → 设置 → 已下载描述文件 → 安装 → 设置 → 通用 → 关于本机 → 证书信任设置 → 打开该 CA 的完全信任开关。
- **Android 壳 App（`packages/mobile`）**：将 `yep-root-ca.crt` 复制到 `packages/mobile/src-tauri/gen/android/app/src/main/res/raw/yep_root_ca.pem`，并在 `res/xml/network_security_config.xml` 的 `<base-config>` 中加入 `<certificates src="@raw/yep_root_ca" />`，重新构建 APK 后即免手动安装系统证书。

---

## 日常无感认证工作流

1. **首次开启认证**：在「设置 → 本地访问」打开「需要密码」，设置强密码（建议配合 Safari/Chrome/iCloud 密码管理器使用 Touch ID / Face ID 自动填充）。
2. **滑动免登**：登录后的 `HttpOnly + Secure + SameSite=Lax` Cookie 采用 **30 天滑动窗口 / 90 天绝对上限**——只要 30 天内有活跃访问，服务端自动顺延 Cookie，日常完全无感。
3. **手机 / Android APK 一键扫码秒登**：在已登录的 Mac 浏览器打开「设置 → 本地访问 → 授权新设备」，点击「生成设备授权码」，用手机扫码或打开复制的 `#pair=<token>` 链接即可免输密码直接登录（120 秒有效、严格单次消费，且 URL fragment 不进入访问日志）。
4. **设备管理与安全兜底**：
   - 登录接口与配对接口内置防爆破限流（连续失败 5 次锁定 60 秒，10 次锁定 15 分钟）；
   - 修改密码会自动吊销其他所有设备的会话；
   - 可在「设置 → 本地访问 → 已登录设备」随时查看并远程踢出单个设备或退出其他所有设备。
---

## 路径 2（备选）：海外低延迟 TCP frp + 域名自动证书

若未来将 frp 换到不拦截 SNI 的香港/新加坡/日本节点，只需将 `TLS_CERT_PATH` / `TLS_KEY_PATH` 指向 `acme.sh --dns dns_cf` 签发的 `fullchain.pem` / `privkey.pem` 即可，服务端双端口 TLS 与热重载代码完全通用，无需任何代码改动。
