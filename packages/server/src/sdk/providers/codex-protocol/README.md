# Codex app-server 协议基线

本目录保存由目标 Codex CLI 二进制生成的完整 app-server 协议基线。它用于
Phase 0 的版本诊断和 schema coverage guard，不表示 Yep 已实现或声明了其中
所有 capability。

## 目录

- `generated/`：`codex app-server generate-ts --experimental` 的完整 TypeScript
  superset；脚本只把相对 import 改写为 NodeNext 所需的 `.js` 后缀。
- `schema/stable/`：默认 `generate-json-schema` 的完整 bundle。
- `schema/experimental/`：带 `--experimental` 的完整 bundle。
- `manifest.json`：Codex 版本、确定性 schema/type hash、stable/experimental
  capability profile、ClientRequest/ServerRequest/ServerNotification 方法清单及
  ThreadItem/UserInput variants。方法清单取 generated TypeScript discriminated
  union 与 JSON Schema 的并集，并记录两种来源各自独有的方法。
- `coverage-registry.json`：手工维护的四类显式分类表。生成脚本不会自动增加
  coverage entry，因此上游新增协议会让 check 失败，直到维护者完成审计。
- `index.ts`：兼容现有 provider import，同时导出完整协议 union。

这里的 `stable`/`experimental` 精确表示目标二进制在默认生成和
`--experimental` 生成之间的可见性差异。它不替代公开 API 稳定性承诺；某些
默认生成类型的描述仍可能标有 `EXPERIMENTAL`。

Codex 的两个生成器并不保证列出完全相同的方法。例如 0.147.0 的 generated
TypeScript 含 `rawResponseItem/completed` 和 `rawResponse/completed`，而对应
JSON Schema 未包含它们。因此 method registry 必须合并双源，不能只从 schema
推断覆盖范围；`methodRegistry.generatedTypeScriptOnly` 与 `jsonSchemaOnly` 用于
让这种差异在升级时可审计。

## 更新与检查

根 `package.json` 的 `yepAnywhere.codexCli.expectedVersion` 记录最后一次成功同步的
版本。sync 检测到已安装 CLI 版本变化时，以该二进制为事实来源重新生成；只有 schema
生成和显式 coverage 审计全部通过后，才同时更新 artifacts、runtime baseline 与版本号。

```bash
pnpm codex:protocol:sync
pnpm codex:protocol:update
pnpm codex:protocol:check
pnpm codex:protocol:test
```

更新流程：

1. 升级本机 Codex CLI；
2. 运行 `sync`（`pnpm dev`、`dev:8022`、`dev:8022:replace`、`dev:auto`、`staging`
   也会在启动前自动运行）；
3. 如果上游新增 server-facing capability，sync 会在写文件前 fail closed；根据报出的
   missing/extra 项审计并更新 `coverage-registry.json`，然后重新 sync；
4. 运行只读 `check` 和聚焦测试；
5. 在变更说明中记录 Codex version、两套 schema hash 和 capability 差异。

`sync` 在版本未变化且 baseline 已存在时快速退出；未安装 Codex CLI 的开发环境会跳过；
本机 CLI 旧于 checked baseline 时也只提示并跳过，不会自动降级仓库。
`update` 强制按当前 CLI 重生成，但同样自动写入 `expectedVersion`。`check` 永远只读，
版本或 artifacts 不一致时只报错，不自动修改工作树。

四类 coverage registry 分别覆盖：

- `ServerRequest`：交互请求或宿主 ownership 类别；
- `ServerNotification`：生命周期、delta、工具、诊断等语义类别；
- `ThreadItem`：canonical item 类别；
- `UserInput`：文本、媒体或结构化上下文类别。

`ClientRequest` 方法完整保存在 manifest 中，但不作为“每个方法都必须由当前
adapter 调用”的实现 coverage；否则会把服务端能力清单错误等同于 Yep 已实现
功能。
