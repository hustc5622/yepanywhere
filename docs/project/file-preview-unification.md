# 文件侧边预览：现状审查与统一设计

日期：2026-10-21。目标：路径一旦被 Yep 识别出来（不论来自 LLM 正文还是工具调用详情），统一由 **Yep 前端 + 一个服务端文件接口** 负责展示；provider 只负责把 session 数据规范化成统一的工具名、输入字段和结果形状，不参与“怎么展示文件”。

## 1. 现状：文件从哪里被识别

| 入口 | 识别方式 | 打开后的展示 |
| ---- | ---- | ---- |
| 助手正文（服务端 markdown augment） | `safe-markdown.ts`：markdown 链接/图片、正文中的绝对路径（`splitTextWithFilePaths`） | 媒体扩展名 → `.local-media-link` → `LocalMediaModal`；其他 → `.local-file-link` → `TextBlock` 判断：项目内 → `FileViewerModal`，项目外 → `LocalFileModal` |
| 助手正文（无 augment 的纯文本兜底） | `TextBlock.renderPlainTextWithLocalMediaLinks` | 只对绝对路径的图片/视频生成链接，其他路径不可点 |
| `Read` 工具 | `ReadRenderer`，结果有 4 种形状：Claude 结构化 text/image/pdf、Pi/mcode/Cursor 的字符串、XML 包装字符串 | text：项目内 → `FileViewerModal`（重新读磁盘）；项目外 → `DetailPanel` 显示工具结果片段。image：base64 内联。pdf：base64 → `window.open`（新标签页，不是侧栏）|
| `Write` / `Edit` | 各自 renderer 内的 `DetailPanel` | 显示写入内容/diff，不能切到“当前文件” |
| `ViewImage`（Codex） | `ViewImageRenderer` | 快照/本地/项目三种来源，用居中 `Modal`（不是侧栏）|
| Codex exec 图片输出 | `CodexExecRenderer.ExecImages` | 居中 `Modal` |
| 用户附件 | `AttachmentPreviewModal` | 居中 `Modal` |
| Inspector 文件列表 | `SessionInspector` | `FileViewerModal` / `SessionSavedFilePanel` / `SessionFileDiffPanel` |
| `Glob` / `Grep` 结果、Bash 输出、Codex `commandActions`(read) | — | **不可点** |

## 2. 现状：服务端文件接口

| 接口 | 范围 | 类型 | 问题 |
| ---- | ---- | ---- | ---- |
| `GET /api/projects/:id/files` + `/files/raw` | 项目根内相对路径 | 文本（~100 种扩展名，1 MB 内联，shiki 高亮，md 渲染）+ 任意二进制 raw | 项目外路径无法使用 |
| `GET /api/local-file` | 任意绝对路径 | 只有 `.md/.markdown/.txt/.json` | 项目外的 `.ts`、`.log`、`.csv` 都打不开；无高亮 |
| `GET /api/local-image` | 任意绝对路径（2026-10-21 起；此前为白名单 ∪ 已知本地项目）| 图片、视频 | 无 pdf/音频 |
| `/api/projects/:p/sessions/:s/files/*` | session 文件快照/操作记录 | 文本 + diff | session 概念，合理，保留 |

## 3. 主要问题

1. **四套查看器**：`FileViewer`、`LocalFileModal`、`LocalMediaModal`、`ReadRenderer` 片段视图（另有 `ViewImage`、`ExecImages`、附件预览），分别自带 loading/error/行号/markdown 切换逻辑，表现不一致（有的是侧栏 `DetailPanel`，有的是居中 `Modal`，PDF 甚至开新标签页）。
2. **“项目内/项目外”分支散落各处**：`ReadRenderer.useReadModalTarget`、`TextBlock.getProjectRelativePath`、`ViewImageRenderer.getProjectRelativePath` 三份实现，语义略有不同（相对路径、`..` 处理）。
3. **类型支持取决于入口**：同一个 `/tmp/a.ts`，在项目内能高亮，在项目外报 “Not a supported local text file type”；正文里的图片能看，`Read` 读过的图片（Pi）只显示占位文本（截图问题，已先行修复，见 §6）。
4. **识别覆盖不全**：`FILE_EXTENSIONS` 不含 `pdf/docx/xlsx/pptx/mp3`；Glob/Grep/Bash 结果中的路径不可点。
5. **provider 层重复做展示适配**：Pi、mcode、Cursor 各自把 `path` 复制成 `file_path`；Pi 与 normalization 把 image block 压成 `[Image]` 字符串，导致前端只能靠猜。

## 4. 目标分层

```
provider（Claude/Codex/Pi/Cursor/mcode/dsh）
  └─ 只做：工具名规范化 + 统一输入字段（file_path）+ 结构化结果（不丢 image/pdf 信息）
shared
  └─ FileRef 模型、路径识别（filePathDetection）、文件类型分类表（唯一来源）
server
  └─ 一个预览接口；项目外路径不限制目录，只依赖 API 认证
client
  └─ 一个 FilePreview 宿主（DetailPanel）+ 按类型注册的 viewer；所有入口只调用 openFile(ref)
```

### 4.1 shared：`FileRef` 与类型分类

```ts
interface FileRef {
  path: string;              // 绝对路径或相对 session cwd 的路径
  line?: number; lineEnd?: number; column?: number;
  /** 工具结果里已有的内容：在“当前文件”和“工具当时看到的内容”之间切换 */
  snapshot?:
    | { kind: "text"; content: string; startLine: number; totalLines?: number }
    | { kind: "image"; dataUrl: string }
    | { kind: "session-record"; recordId: string };
}
type PreviewKind = "text" | "markdown" | "image" | "video" | "audio" | "pdf"
  | "csv" | "office" | "binary";
function classifyPreview(path: string, mime?: string): PreviewKind;
```

`classifyPreview` 与扩展名表只在 shared 定义一次，取代 `files.ts` 的 `MIME_TYPES/TEXT_EXTENSIONS`、`local-image.ts` 的 `MEDIA_EXTENSIONS`、`safe-markdown.ts` 与 `TextBlock` 的 `IMAGE/VIDEO_EXTENSIONS`、`FileViewer.getLanguageFromPath`。

### 4.2 server：统一预览接口

- `GET /api/fs/preview?path=&projectId=&sessionId=&highlight=1` → `{ metadata{absolutePath,size,mime,kind}, content?, highlightedHtml?, renderedMarkdownHtml?, rawUrl, converted? }`
- `GET /api/fs/raw?path=…&download=` → 字节流（Range 支持，给视频/PDF）。
- 相对路径按 `sessionId` 的 cwd（无则项目根）解析。**访问策略（已决策）：不限制目录**，服务端能读的绝对路径都可预览，只依赖 Yep 的 API 认证；不再维护白名单，`ALLOWED_IMAGE_PATHS` 已删除。
- 现有 `/api/projects/:id/files*`、`/api/local-file`、`/api/local-image` 变为该实现的薄包装，保留 URL 兼容旧 markdown augment 与已缓存的 HTML，之后再逐步收敛。
- Office/表格转换放服务端、按需、带大小上限：`docx` → HTML（如 mammoth，经现有 sanitize）、`xlsx/csv` → 前 N 行表格 JSON、`pptx` 只给元数据 + 下载。远程项目（`isRemoteProject`）明确返回“不支持”而不是 404。

### 4.3 client：一个宿主，多种 viewer

- `FilePreviewProvider`（挂在 session 页）持有当前打开的 `FileRef`，渲染唯一的 `DetailPanel`；`useOpenFile()` 返回 `openFile(ref, {newTab?})`。替代各 renderer 里各自的 `useState(showModal) + <DetailPanel>`。
- viewer 注册表：`text`（shiki/行号/行定位，合并 `FileViewer` 与 `LocalFileModal`）、`markdown`（源码/预览切换）、`image`、`video`、`audio`、`pdf`（`<iframe src=rawUrl>`，移动端退回下载/外部打开）、`csv`/`office`（服务端转换结果）、`binary`（元数据 + 下载）。
- header 统一：文件名、目录、复制标题/路径/全文、新标签页、下载、全屏；有 `snapshot` 时出现“当前文件 / 工具结果”切换（解决“项目内 Read 显示的是现在的磁盘内容而非读取时内容”的语义差异）。
- 入口全部改为 `openFile`：`TextBlock` 点击拦截、`ReadRenderer`、`Write/Edit`（可选打开当前文件）、`ViewImage`、`ExecImages`、`Glob/Grep` 结果行、Inspector 文件列表、附件预览。`ViewImage`/`ExecImages`/`LocalMediaModal` 由居中 `Modal` 改为侧栏。

### 4.4 provider：只交付规范化数据

- 新增共享 `normalizeFileToolInput(input)`（`path`/`filePath`/`locations[0].path` → `file_path`），Pi、mcode、Cursor 删除各自的复制逻辑。
- 工具结果的 image/pdf block 不再压成 `[Image]`：保留结构化引用（mime + 可选 data 或 snapshot URL，参考 Codex 的 `codex-image-reader` 快照接口），前端按 `snapshot.kind = "image"` 展示；做不到时至少保留 mime，前端按路径回落读取。
- Codex：把 app-server `commandActions` 中 `type: "read"` 的 `path` 带进 Bash/exec 的 tool input，使 `cat/sed -n` 读文件也能点开。
- dsh 只读 provider 同样只负责解析，自动获得全部预览能力。

## 5. 分阶段落地

| 阶段 | 内容 | 风险/影响 |
| ---- | ---- | ---- |
| P0 ✅ | 修复 Read 图片占位文本（§6）| 仅客户端，`client` 档热叠加 |
| P1 ✅ | shared `classifyPreview` + 扩展名表收敛；`FILE_EXTENSIONS` 增加 pdf/office/音频 | 纯重构 + 识别范围扩大（见 §7）|
| P2 ✅ | server `/api/fs/preview|raw`，旧接口改薄包装 | 见 §8 |
| P3 ✅ | client 统一预览入口，迁移 `FileViewer`/`LocalFileModal`/`LocalMediaModal`/Read 片段 | 见 §9 |
| P4 ✅ | 新类型：pdf 内嵌、csv 表格、docx/xlsx/pptx 服务端转换、音频 | 见 §10；无新增依赖 |
| P5 ✅ | 入口补全：正文/行内代码路径、Glob/Grep、shell 读文件命令；provider 侧统一 `file_path` | 见 §11 |

## 6. P0 已做的修复

截图中的 Pi `Read /tmp/pw/c-1.png`：Pi 返回 `[{text:"Read image file [image/png]"},{image}]`，`pi.ts`/`normalization.ts` 把 image block 压成 `[Image]`，`ReadRenderer` 按文本当作 2 行文件。修复：`ReadRenderer` 识别 `Read image file [image/*]` 或“图片扩展名 + `[Image]` 结尾”的字符串结果，改为按路径预览——项目内走 `FileViewerModal`，项目外在 `DetailPanel` 中通过 `/api/local-image` 加载（复用 `ViewImageRenderer` 导出的 `LocalImagePreview`）。随后按“项目外不限制路径”的决策去掉了 `/api/local-image` 的白名单（同时删除 `ALLOWED_IMAGE_PATHS` 配置及部署脚本中的相关检查），任意绝对路径的图片都能预览。

## 7. P1 已完成：文件类型表收敛

唯一来源：`packages/shared/src/file-types.ts`。

- 导出：`PreviewKind`（`text`/`markdown`/`image`/`video`/`audio`/`pdf`/`office`/`binary`）、`getFileTypeInfo`、`classifyPreview(path, mime?)`、`getFileMimeType`、`isTextFilePath`、`isMarkdownFilePath`、`getMediaPreviewKind`（只返回 `image`/`video`，对应 `/api/local-image` 能服务的类型）、`getKnownFileExtensions`、`getFileExtension`、`getPathBasename`。
- 扩展名规则与 Node `extname` 一致（`.env` 无扩展名）；无扩展名的常见文件（`Dockerfile`、`Makefile`、`.gitignore` 等）按文本处理；SVG 是 `image` 且 `isText`。`csv/tsv` 暂归 `text`，P4 做表格视图时再拆。
- 已迁移的调用方：`routes/files.ts`（删除 `MIME_TYPES`/`TEXT_EXTENSIONS`/`TEXT_DOTFILES`）、`routes/local-file.ts`（支持全部文本类型）、`routes/local-image.ts`、`routes/session-display.ts`、`augments/safe-markdown.ts`、`augments/read-augments.ts`、`filePathDetection.ts`（`FILE_EXTENSIONS` 改为从表派生）、客户端 `TextBlock`、`FileViewer`、`ReadRenderer`、`GitStatusPage`、`lib/userPromptContent.ts`。
- 有意未合并：shiki 语言映射（`server/src/highlighting` 的 `EXTENSION_TO_LANG`，以及 `FileViewer.getLanguageFromPath` 仅用于 `data-language`）；静态资源、报告、飞书、上传等与预览无关的 MIME 表。

## 8. P2 已完成：服务端统一预览接口

核心实现：`packages/server/src/file-preview/index.ts`，路由：`packages/server/src/routes/fs.ts`（挂载于 `/api/fs`）。

- `resolvePreviewPath(path, baseDir?)`：绝对路径直接用；相对路径需要 `baseDir`（项目根）；`:line[:col]` 后缀仅在字面文件不存在时剥离。
- `openPreviewFile`：`realpath` + 必须是普通文件，错误统一为 `FilePreviewError`（404 不存在、400 非文件）。
- `buildFilePreview`：`FileContentResponse` + `kind`；文本 ≤ 1 MB 内联，可选 shiki 高亮与 Markdown 渲染。
- `rawFileResponse`：流式读取、单段 `Range`（206／416）、`inline`／`attachment` 带 UTF-8 文件名；`text/html`、`image/svg+xml`、`*+xml` 附加 `Content-Security-Policy: …; sandbox`（PDF 不加，否则浏览器内置查看器无法打开）。

| 接口 | 现状 |
| ---- | ---- |
| `GET /api/fs/preview?path=&projectId=&highlight=true` | 新，统一入口；响应额外带 `lineNumber`／`columnNumber` |
| `GET /api/fs/raw?path=&projectId=&download=true` | 新，统一字节流 |
| `/api/projects/:id/files`、`/files/raw` | 薄包装；保持项目内路径校验与原 `rawUrl` |
| `/api/local-file` | 薄包装；仍只接受绝对路径文本，保留 413；`rawUrl` 改为 `/api/fs/raw` |
| `/api/local-image` | 薄包装；仍只服务图片／视频及嗅探出的无扩展名图片，新增 `Range` |

未做：按 `sessionId` 的 cwd 解析相对路径（目前项目根即 session cwd，必要时再加）；远程项目（`isRemoteProject`）不解析相对路径。客户端仍调用旧接口，P3 迁移到 `/api/fs/*`。

## 9. P3 已完成：客户端统一预览

- **模型**：`packages/client/src/lib/fileRef.ts`。`FileRef { path, projectId?, lineNumber?, lineEnd? }`；`fileRefFromPath(path, sessionMetadata)` 把相对路径按会话项目根转成绝对路径（不知道项目根时保留 `projectId` 交给服务端解析）；`fileRawUrl`、`filePageUrl`／`filePageRoute`、`extractFileLinkTarget`（解析 `.local-file-link`、`.local-media-link`、`/api/fs/raw` 链接）。`FileSnapshot` 为工具读取时的内容（`text`／`image`）。
- **查看器**：`components/FileViewer.tsx` 只调用 `api.getFilePreview`（`/api/fs/preview`），按 `kind` 渲染：文本／Markdown（shiki 或纯文本，`lineNumber`～`lineEnd` 在两种模式下都会标记并滚动到位，Markdown 无行号目标时默认预览）、图片、视频、音频、PDF（`iframe`）、其他类型给下载。传入 `snapshot` 时出现“当前文件／工具结果”切换；文件读不到时自动显示快照。Markdown 预览里的文件链接在面板内跳转。
- **入口**：`components/FilePreviewPanel.tsx` 提供 `FilePreviewPanel`（`DetailPanel` + `FileViewer`）、`useFilePreview()`（`openFile(ref, {snapshot})` + 渲染一次 `filePreview`）、`FileOpenButton`。每个调用方各自持有面板，嵌套在子 agent 详情面板里时仍正确叠放；`DetailPanel` 本身保证同一时刻只停靠一个。
- **已迁移**：`TextBlock`（所有 `.local-file-link`／`.local-media-link`，修饰键点击打开独立页）、`ReadRenderer`（文本带快照、按行范围定位；Claude 图片带图片快照；PDF 改为侧栏，只有缺路径时才回退到新标签页）、`ViewImageRenderer`（路径来源走统一面板，Codex 快照图改用 `DetailPanel`）、`CodexExecRenderer` 图片输出（`Modal` → `DetailPanel`）、`SessionInspector`、`FilePage`。
- **独立页**：新增 `/file?path=&projectId=&line=`（项目外文件也能在新标签页打开）；旧的 `/projects/:projectId/file?path=` 继续可用。
- **已删除**：`FilePathLink.tsx`（及未使用的 `FilePathLink` 组件）、`LocalFileModal.tsx`、`LocalMediaModal.tsx`、对应 CSS、`ViewImageRenderer` 的 `LocalImagePreview`、`ReadRenderer` 的片段模态与项目内外分支、i18n `fileMissingProjectId`。
- **未纳入**：上传附件预览 `AttachmentPreviewModal`（uploads 有自己的接口与缩略图）；会话快照／diff 面板（session 概念，属于 provider 侧数据）；`Write`／`Edit` 的内容/diff 面板。正文里纯文本出现的非媒体路径、行内代码中的路径、Glob／Grep 结果仍不可点，留给 P5。

## 10. P4 已完成：新增文件类型

- **PDF／视频／音频**：P3 已内嵌（`iframe`／`video`／`audio`，`/api/fs/raw` 支持 `Range`）。
- **CSV／TSV**：客户端 `lib/delimitedText.ts`（RFC 4180：引号、转义引号、引号内换行、CRLF，最多 1000 行）。`FileViewer` 对 `.csv`／`.tsv` 默认“表格”视图，可切回“源码”；有行号目标时默认源码。
- **docx／xlsx／pptx**（含 `docm/xlsm/pptm`）：服务端 `file-preview/office.ts`，**不引入第三方依赖**——自带 ZIP 中央目录读取（`inflateRawSync` 限制单个部件 64 MB，文件上限 30 MB，不支持 ZIP64）与按标签提取：
  - docx：标题（Heading/Title）、段落、换行／制表、列表、表格（嵌套表格压平到单元格），输出由转义文本和固定标签组成的 HTML，最多 3000 块；删除修订（`w:delText`）不显示。
  - xlsx：按 `_rels/.rels` → workbook → 关系解析工作表（兼容任意命名空间前缀与非标准部件路径），共享字符串、行内字符串、布尔、数值原值；每表最多 500 行 × 50 列、最多 20 个工作表；公式只显示缓存值，日期显示原始数值。
  - pptx：按 `sldIdLst` 顺序提取每页文字段落，最多 300 页。
  - 结果放在 `/api/fs/preview` 响应的 `office` 字段（类型 `OfficeDocumentPreview`），失败时给 `officeError`（如加密文件、非 ZIP）；客户端 `OfficeView` 显示文档、带工作表标签的表格或逐页文字，并提示“仅提取文字”。
- **未支持**：旧二进制格式 `doc/xls/ppt`、`odt/ods/odp`、`rtf`，以及图片／图表／样式；这些显示文件信息与下载。

## 11. P5 已完成：入口补全与 provider 分工

- **正文路径**（服务端 `safe-markdown.ts`，仅 `message` 样式）：纯文本中的路径与“整段只是一个路径”的行内代码（如 `` `packages/server/src/app.ts:12` ``）都变为预览链接；规则统一为 shared `isPreviewLinkablePath`：绝对路径需带扩展名，相对路径需含目录且属已知文件类型（`src/utils`、`and/or`、单独的 `README.md` 不链接）。`document` 样式（文件预览中的 Markdown）不变，避免链接嵌套和相对路径歧义。客户端无 augment 的纯文本兜底使用同一规则。
- **Glob／Grep**：结果列表每行可点开；Grep 内容模式中 `path:行号:`／`path-行号-` 前缀可点开并定位到行。相对结果按工具的搜索根（绝对时）或项目根解析（`renderers/tools/FileListItem.tsx`）。
- **Shell 读文件命令**（provider 无关，`lib/shellFileRead.ts`）：`cat`／`nl`／`bat`／`less`／`head`／`tail`／`sed -n 'a,bp'` 读单个文件，及 `… | sed -n 'a,bp'`／`… | head -n N`，在 Bash 展开视图显示“读取文件 xxx:a-b”，按命令的 `workdir`／`cwd`（如有）解析相对路径；含通配、变量、重定向、`&&` 等的不识别。
- **provider 侧**：shared `withCanonicalFilePath(input, locations?)` 统一把 `path`／`filePath`／ACP `locations[].path` 补成 `file_path`，Pi、MiniMax Code、Cursor 删除各自的复制逻辑。
- **关于 `[Image]`**：有意保留。转录中不携带图片字节（避免显示快照膨胀），展示层按路径读取图片（见 §6 与 P3 的 Read 处理）；这正是“provider 只交付规范化数据、Yep 统一展示”的分工。Codex app-server 的 `commandActions` 目前只出现在审批请求里，历史中不存在，因此改为客户端解析命令文本，对所有 provider 生效。

## 12. 相对路径找不到时：说明 + 按需跨项目查找

相对路径只能按会话项目（或工具的搜索根／命令 `workdir`）解析；回复引用别的项目文件时会解析错。处理方式：

- `fileRefFromPath` 在解析相对路径时记录 `FileRef.relative = { path: 原写法, baseDir }`（`../` 开头的不记录）。
- `FileViewer` 在预览返回 404 且有 `relative` 时显示“按 {baseDir 名} 解析未找到”，并给出“在其他项目中查找该文件”按钮；**只有点击后**才请求 `GET /api/fs/locate?path=<相对路径>`。
- `/api/fs/locate`：遍历本地（非远程）项目，返回根目录下该相对路径为普通文件的项目列表（`FileLocateCandidate`）；拒绝绝对路径和 `..`。客户端排除已失败的那一项，点选后在面板内打开并保留行号目标。
- 不在渲染时检查文件是否存在：回复 HTML 是缓存的、与会话无关，且文件可能稍后才出现。
