# 远程访问

Yep Anywhere 运行在你的开发机上。如果想从手机或局域网外的其他设备访问它，需要配置远程访问。

本分支的远程访问依赖你自己的局域网、组网工具、反向代理或隧道；当前没有 README 中旧 Relay 配置对应的用户入口。

## 可选方案

以下方案都应将流量转发到服务端本机端口，开发模式默认是 3400，生产模式默认是 8022。

## 方案 1：Tailscale（推荐）

[Tailscale](https://tailscale.com) 会在你的设备之间创建一个私有网络。无需端口转发，也不需要手动配置防火墙。

**配置步骤：**

1. 在开发机和手机上安装 Tailscale
2. 两台设备登录同一个账号
3. 通过 `http://<tailscale-ip>:8022` 访问生产服务，或在开发时使用 3400 端口

**优点：** 非常简单、加密、可穿透 NAT，个人使用免费

**缺点：** 需要 Tailscale 账号，每台设备都要安装应用

**注意：** Chromebook 上安装 Tailscale Android 应用可能会遇到问题，这种情况下可以考虑 Cloudflare Tunnel。

## 方案 2：Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 可以通过 Cloudflare 网络暴露你的本地服务，不需要端口转发。

**配置步骤：**

1. 创建一个免费的 Cloudflare 账号
2. 添加域名，或者测试时使用免费的 `*.trycloudflare.com` URL
3. 在开发机上安装 `cloudflared`：

   ```bash
   # macOS
   brew install cloudflared

   # Linux
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
   chmod +x cloudflared
   ```

4. 启动 tunnel：

   ```bash
   # 快速测试（随机 URL，不需要账号）
   cloudflared tunnel --url http://localhost:8022

   # 持久配置（需要 Cloudflare 账号 + 域名）
   cloudflared tunnel create yep-anywhere
   cloudflared tunnel route dns yep-anywhere claude.yourdomain.com
   cloudflared tunnel run yep-anywhere
   ```

**优点：** 免费、自动处理 HTTPS、无需端口转发

**缺点：** 持久 URL 需要 Cloudflare 账号

## 方案 3：Caddy + SSH Tunnel（自托管）

如果你有一台带公网 IP 的服务器（例如已转发 443 端口的 Raspberry Pi），可以用 Caddy 提供 HTTPS，再用 SSH tunnel 连接回开发机。

**在公网服务器上（例如 Raspberry Pi）：**

1. 安装 [Caddy](https://caddyserver.com)
2. 将 DNS A 记录指向你的家庭公网 IP
3. 创建 `/etc/caddy/Caddyfile`：

   ```text
   claude.yourdomain.com {
       reverse_proxy 127.0.0.1:8022
       basicauth /* {
           youruser $2a$14$hashedpassword
       }
   }
   ```

   使用 `caddy hash-password` 生成密码 hash。

4. 启动 Caddy：`sudo caddy start --config /etc/caddy/Caddyfile`

**在开发机上：**

配置反向 SSH tunnel，把本地端口转发到服务器：

```bash
# 一次性运行
ssh -N -R 8022:localhost:8022 yourserver

# 持久运行（需要安装 autossh）
autossh -M 0 -N -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" \
    -R 8022:localhost:8022 yourserver
```

如果使用 systemd service，创建 `~/.config/systemd/user/claude-tunnel.service`：

```ini
[Unit]
Description=SSH tunnel for Yep Anywhere
After=network.target

[Service]
ExecStart=/usr/bin/autossh -M 0 -N -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -R 8022:localhost:8022 yourserver
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

然后运行：

```bash
systemctl --user enable claude-tunnel
systemctl --user start claude-tunnel
```

**优点：** 完全可控，不需要第三方账号

**缺点：** 配置更复杂，需要已有服务器基础设施

## 安全注意事项

- Yep Anywhere 可以访问你的代码库。只使用你信任的远程访问方式。
- Tailscale 的组网链路已加密，但示例使用 HTTP；Cloudflare Tunnel 和 Caddy 可提供 HTTPS。
- 建议额外添加认证层，例如 basic auth、Cloudflare Access 等。
- 服务器默认只监听 localhost。远程访问方案应 tunnel 到 localhost，而不是直接监听所有网卡。

### Yep Anywhere 登录密码

在服务器项目目录运行 `pnpm yep setup-admin-password`，设置或重置当前系统用户所有 Profile 共用的管理员密码。然后从服务器电脑的 loopback 页面打开现有“设置 → 本地访问”，使用管理员密码启用、修改或关闭普通登录密码。远程用户只能使用普通登录密码登录；运行时没有认证绕过开关。

管理员操作要求 socket 对端和请求 URL 主机都为 loopback。同机反向代理必须保留外部 `Host`，不得把远程密码管理请求改写成 loopback 主机；否则 Node 服务无法区分该请求与真正的本机请求。
