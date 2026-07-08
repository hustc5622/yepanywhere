# Android Agent Control：Accessibility Tree + CLI Skill

## 目标

为 Android 设备增加结构化 UI 理解能力，让 AI agents 能高效操作设备，不依赖截图、不依赖 MCP，也不依赖 vision model。设计参考 [chromeos-testbed](~/code/chromeos-testbed)：agent 直接调用 CLI，背后由设备端 daemon 支撑。

Streaming infrastructure（device-bridge、WebRTC、H.264）负责 **人类** 远程查看；这一层负责 **agent** 控制：快速 accessibility tree snapshot、按 ref 操作元素、文本搜索，并通过现有 APK 的 TCP connection 完成通信。

## 参考项目

- **[iPhone-MCP](https://github.com/blitzdotdev/iPhone-mcp)**（clone 在 `~/code/references/iPhone-mcp`）：通过 WebDriverAgent（实体机）和自定义 `ax-scan` Objective-C daemon（模拟器）控制 iOS agent。Grid-based accessibility probing，quarter-screen 约 250ms。架构值得参考，但它基于 MCP。
- **[mobile-mcp](https://github.com/mobile-next/mobile-mcp)**：跨平台（iOS + Android），为 LLM 提供 accessibility snapshots，是 MCP 项目里较完整的一个。
- **[Android-MCP (CursorTouch)](https://github.com/CursorTouch/Android-MCP)**：轻量，使用 ADB + Android Accessibility API。
- **[Android-Mobile-MCP](https://github.com/erichung9060/Android-Mobile-MCP)**：另一个连接 AI agents 和 Android 的 MCP server。
- **[mcp-android-server-python](https://github.com/nim444/mcp-android-server-python)**：使用 uiautomator2 的 Python MCP server。
- **[chromeos-testbed](~/code/chromeos-testbed)**：我们自己的 ChromeOS agent control。使用 CDP + `chrome.automation` 获取桌面 accessibility tree，Bash CLI + 设备端 Python handler。**这是本工作的直接参考模型。**

上面这些 Android 项目通常每条命令都 shell out 到 `adb`，速度较慢。我们的 APK 已经有持久 TCP connection，可以做得更快。

## Android Accessibility APIs

| 方法 | 延迟 | 需要 root | 限制 |
|------|------|-----------|------|
| `adb shell uiautomator dump` | ~1-3s | 否 | 慢，需要启动进程；动画 UI 上容易失败；输出 XML |
| **UiAutomation**（in-process，通过 app_process） | ~50-100ms | 否 | 需要 reflection 从 shell user context 获取实例 |
| **AccessibilityService**（安装 APK） | ~50-100ms | 否 | 用户需要手动在 Settings 里启用 |
| `adb shell dumpsys activity top` | ~200ms | 否 | 信息很有限，只有 view hierarchy，没有 accessibility labels |

我们使用 **UiAutomation**，因为 `DeviceServer.java` 已经通过 `app_process` 以 shell user 运行，并且已经为 `SurfaceControl` 和 `InputManager` 使用 reflection。这和 uiautomator2、scrcpy 的思路一致。

## 需要改变什么

### 1. 扩展 DeviceServer.java

通过 reflection 增加 `UiAutomation` 访问。Shell user（`app_process`）可以直接连接 accessibility manager service 创建 `UiAutomation` 实例，不需要 Instrumentation。

新增 control commands：

```json
{"cmd": "snapshot", "maxDepth": 10}
{"cmd": "find", "text": "Sign In", "role": "button"}
{"cmd": "action", "ref": 5, "action": "click"}
{"cmd": "action", "ref": 3, "action": "setText", "text": "user@example.com"}
{"cmd": "info"}
{"cmd": "apps"}
{"cmd": "launch", "package": "com.example.app"}
```

关键 Java APIs（shell user 可用）：

```java
// Obtain UiAutomation via reflection (same technique as uiautomator2-server)
UiAutomation uiAutomation = /* reflection on UiAutomationConnection */;
AccessibilityNodeInfo root = uiAutomation.getRootInActiveWindow();

// Walk tree
node.getClassName()           // "android.widget.Button"
node.getText()                // "Sign In"
node.getContentDescription()  // accessibility label
node.getBoundsInScreen(rect)  // screen coordinates
node.isClickable()
node.isEditable()
node.isScrollable()
node.getChildCount()

// Perform actions by node reference
node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
    Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "hello") });
node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
```

### 2. Protocol extension：query responses

当前 0x03 control messages 是 fire-and-forget。查询类命令需要 response。

**Option A（简单）：** 复用 0x03。`snapshot`、`find`、`info`、`apps` 这类 query command 会发回 0x03 response。Go/CLI 侧根据 command name 判断哪些命令需要 response。

**Option B（显式）：** 增加 0x04 作为 query/response 类型：

```text
Query (sidecar -> device):   [0x04][len u32 LE][JSON]
Response (device -> sidecar): [0x04][len u32 LE][JSON]
```

选择 Option A。它更简单，也不会破坏现有协议；sidecar 只需要在发送特定命令后读取 response。

### 3. CLI：`bin/android-agent`

一个独立 CLI（bash wrapper + TypeScript/Go core），自己管理 ADB forward，并直接和设备 APK 说 binary framing protocol。它 **独立于 bridge sidecar**，agent 不需要启动 streaming session 也能使用。

```text
CLI (on Mac) -> adb forward tcp:27183 tcp:27183 -> DeviceServer APK (on device)
```

#### Commands

```bash
# Accessibility tree
android-agent snapshot                        # Full UI tree (compact format)
android-agent snapshot --depth 3              # Limited depth
android-agent find "Sign In" --role button    # Find elements by text/role
android-agent find "Settings" --nth 2         # Select Nth match

# Actions by reference (from snapshot output)
android-agent tap 5                           # Tap element ref #5
android-agent tap "Sign In"                   # Tap by text match (auto-find + tap)
android-agent type 3 "user@example.com"       # Type into ref #3
android-agent swipe 5 down                    # Swipe element down
android-agent action 5 longClick              # Long click ref #5
android-agent scroll 4 down                   # Scroll container

# Actions by coordinates (fallback)
android-agent tap-xy 540 960                  # Raw coordinate tap

# Text input
android-agent key back                        # Hardware key
android-agent key enter
android-agent text "hello world"              # Type text (no target element)

# Screen
android-agent screenshot                      # Returns file path
android-agent screenshot --scale 0.5          # Downscaled

# App management
android-agent launch com.example.app          # Launch by package
android-agent apps                            # List installed apps
android-agent current                         # Current foreground app

# Device info
android-agent devices                         # List connected devices
android-agent info                            # Screen size, API level, etc.
```

#### 输出格式（LLM-friendly）

像 chromeos-testbed 的 `desktop-tree` 一样，输出带 ref 的紧凑缩进树：

```text
[0] FrameLayout {0,0 1080x2400}
  [1] LinearLayout {0,100 1080x200}
    [2] Button "Sign In" {400,120 280x60} clickable focused
    [3] EditText "Email" {100,120 280x60} editable text=""
  [4] RecyclerView {0,200 1080x2200} scrollable
    [5] TextView "Item 1" {0,200 1080x100}
    [6] TextView "Item 2" {0,300 1080x100}
```

每次 snapshot 给元素分配稳定 refs。Agent 可以执行 `android-agent tap 2` 来点击 “Sign In”。

如需程序化使用，可通过 `--json` 输出 JSON。

### 4. Skill definition

Agent 可在 `AGENTS.md` 中引用一个 markdown skill 文件：

```markdown
# Android Agent Skill

Control Android devices (emulators and physical) for testing and automation.

## Quick Start
1. `android-agent snapshot` — see what's on screen
2. Find element by ref number or text
3. `android-agent tap <ref>` or `android-agent tap "Button Text"`
4. `android-agent snapshot` — verify result

## Workflow: snapshot → act → snapshot
```

### 5. Diff snapshots（未来增强）

Action 后只返回变化，而不是完整 tree。这样可以显著减少 LLM token：

```bash
android-agent tap 2
# output: action applied, 3 nodes changed:
#   [2] Button "Sign In" → removed
#   [7] ProgressBar "Loading..." {400,120 280x60} (new)
#   [1] LinearLayout → children changed
```

## 性能对比

| 维度 | 现有项目（Android-MCP 等） | 我们的方案 |
|------|----------------------------|------------|
| **Transport** | 每条命令 shell out 到 `adb`，约 200ms spawn overhead | 通过 APK 持久 TCP connection，query 约 10ms |
| **Snapshot speed** | `adb shell uiautomator dump`，约 1-3s，动画 UI 易失败 | in-process `UiAutomation.getRootInActiveWindow()`，约 50-100ms |
| **Input** | `adb shell input tap`，需要启动进程 | 通过 reflection 调 `InputManager.injectInputEvent()`，<10ms，已有能力 |
| **Protocol** | MCP（JSON-RPC over stdio，需要 MCP client 配置） | 普通 CLI，任何 agent、任何 shell 都可用 |
| **Integration** | 每个 agent 都要配置 MCP | 放一个 skill 文件，在 `AGENTS.md` 中引用 |

## 实现阶段

### Phase 1：DeviceServer.java 中支持 UiAutomation

1. 通过 reflection 增加 `UiAutomation` 访问，对齐 uiautomator2-server 的做法。
2. 实现 `snapshot` command：遍历 `AccessibilityNodeInfo` tree，输出紧凑 JSON。
3. 实现 `find` command：支持 text/role matching 和 regex。
4. 实现 `action` command：通过 node reference 执行 click、setText、scroll、longClick。
5. 为协议增加 query response 支持，即带 response 的 0x03。

测试：`adb forward` + 手写 TCP client 验证 responses。

### Phase 2：CLI（`bin/android-agent`）

1. 构建 CLI，管理 ADB forward，并说 binary protocol。
2. 实现所有命令：snapshot、find、tap、type、key、screenshot、launch 等。
3. 输出紧凑 tree format，带缩进和 refs。
4. 增加 `--json` 方便程序化使用。
5. 增加 `--device` 支持多设备，默认使用第一台 connected device。

测试：对 emulator 运行，验证 snapshot output 和 tap-by-ref workflow。

### Phase 3：Skill + Agent integration

1. 编写 skill definition markdown。
2. 从项目 `AGENTS.md` 引用它。
3. 用 Claude Code 测试：是否能只靠 CLI 导航 app？
4. 根据 agent 遇到的问题迭代输出格式。

### Phase 4：增强

- Diff snapshots，action 后返回变化。
- Targeted queries，不必每次完整 tree walk。
- Element watching，元素出现/消失时通知。
- `android-agent wait "Loading"`：阻塞直到元素出现。
- Batch commands，例如 `android-agent do tap 2, wait "Welcome", screenshot`。

## 文件位置

| 组件 | 路径 |
|------|------|
| APK source | `packages/android-device-server/app/src/main/java/com/yepanywhere/DeviceServer.java` |
| Binary framing | `packages/device-bridge/internal/conn/framing.go` |
| CLI | `bin/android-agent`（新增） |
| Skill definition | `skills/android-agent.md`（新增） |
| 本文档 | `docs/project/device-bridge-android-a11y.md` |
