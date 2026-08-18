# Session transcript 复制时选区被"吞掉上面内容"——排查结论与修复计划

- 日期：2026-08-17
- 触发场景：`/yep/projects/L1VzZXJzL3l1ZXl1YW4vRGVza3RvcC93b3JrL2FwaS10ZXN0aW5n/sessions/01a00b50-6668-71f2-a819-50bd42eb4ab1`
- 现象：用鼠标拖选 transcript 中的一段文本，一旦滑动（向上滚动），选区就被扩张到列表开头，复制出来的内容包含大量用户没有选中的上文。
- 状态：**根因已用 headless Chrome 复现确认**，本文件是实施计划（尚未改代码）。

---

## 1. 结论（一句话）

向上滑动触发了「自动加载更旧消息」，prepend 之后**顶部那个 assistant turn 的 React key 变了**，整行 DOM 被卸载重建，Chrome 把选区端点"修复"到 `.message-list` 容器上；再加上**prepend 的滚动补偿是空转**，视口内容整体错位约 2 万像素，于是鼠标一动就从列表开头选到光标处。

两个缺陷叠加，缺一不可：

| # | 缺陷 | 代码位置 |
| - | ---- | -------- |
| A | assistant-turn 行 key 取「窗口内该 turn 的第一个 item id」，prepend 后必变 | `packages/client/src/components/messageRows.ts:294` |
| B | 自动分页无选区/拖拽保护 | `packages/client/src/components/MessageList.tsx:392-405` |
| C | prepend 的滚动补偿在数据到达前就测量，delta≈0，形同空转 | `packages/client/src/components/MessageList.tsx:328-353` |

---

## 2. 已确认的事实与实测数据

### 2.1 静态事实

- 页面结构：`SessionPage` 的 `<main className="session-messages">`（滚动容器，`packages/client/src/pages/SessionPage.tsx:2057`）> `MessageList` 的 `.message-list`（行容器）。
- 分页：`INITIAL_MESSAGE_LIMIT = 100`（`packages/client/src/hooks/useSessionMessages.ts:161`）。该 session canonical 视图共 466 条消息，首屏只给 100 条，`pagination.hasOlderMessages = true`（只读 API 验证）。
- 自动加载：`MessageList.handleScroll` 在 `container.scrollTop < 200` 时直接调用 `loadOlder()`，没有任何选区/拖拽保护。
- 行 key：`key: \`turn-${firstItem.id}\``（`messageRows.ts:294`）；`getRowKey` 在 `messageRows.ts:200`；消费点在 `MessageList.tsx:786`（非虚拟化路径）与 `MessageList.tsx:310`（虚拟化 `getItemKey`）。
- 复制链路会忠实放大坏选区：`MessageActions.handleCopy` → `getSelectionAwareCopyText`（`packages/client/src/lib/clipboard.ts:91`）优先使用当前 selection，`rangeIntersectsRoot` 只做"相交"判断，因此 Cmd+C 与任一 turn 的复制按钮都会带出整段超大文本。

### 2.2 行模型实测（临时 vitest 脚本，已删除）

用该 session 真实数据跑 `preprocessMessages` + `buildMessageRows`：

| 窗口 | rows | 顶部 turn 的 key |
| ---- | ---- | ---------------- |
| 最后 100 条 | 21 | `turn-749622e3-0` |
| 最后 200 条 | 41 | `turn-ad92b68e-0`（同一个视觉 turn，key 变了） |
| 最后 300 条 | 51 | 又变成另一个值 |
| 全部 466 条 | 67 | — |

除顶部那一行，其余行 key 完全不变。

### 2.3 浏览器复现（`/tmp/selprobe/repro.mjs`，系统 Chrome，headless，独立实例）

**向上滚场景（触发加载）**

```
初始拖选:      len=15   anchor=#text(正常)         rows=20  scrollHeight=25245
向上滚之后:    len=0    anchor=.message-list@1     rows=40  scrollHeight=45109
再动一下鼠标:  len=442  内容变成 "Bash cd /Users/... 2669 passed..."（从未选中的上文）
DOM 变化:      removed=["assistant-turn:3695"]  之后 added=21 个新行
```

**对照组：向下滚（不触发加载）**

```
向下滚之后:    len=15  anchor 不变  rows=20  DOM mutations = []
再动鼠标:      len=848 以原本选中的那句话开头 —— 完全正常
```

→ 排除 `user-select: none`、滚动本身、虚拟化等嫌疑。

### 2.4 滚动补偿实测（`/tmp/selprobe/repro3.mjs`）

```
停在 scrollTop=300 :  rows=20  scrollHeight=25245  marker 行 top=2482
自动加载后         :  rows=40  scrollHeight=45109  marker 行 top=22464  scrollTop=181(未变)
被移除的已有行     :  恰好 1 个 assistant-turn(3695 字符)，其余 19 行保留
```

上方插入 ~19900px 内容而 `scrollTop` 不动，标记行位移 +19982px。浏览器 scroll anchoring 也救不了：anchor 节点正是被 remount 掉的那一行。

### 2.5 顺带发现（本次不修，记为后续项）

- `VIRTUALIZE_ROW_THRESHOLD = 80`（`MessageList.tsx:38`），而一个 turn 只算一行 → turn-grouped transcript 几乎永远达不到 80 行，**虚拟化实际上很少生效**（该 session 全量加载也只有 67 行）。
- `planActiveMessageWindowTrim`（`useSessionMessages.ts:298`）在活跃会话里从顶部裁剪消息，等价于一次"反向 prepend"，同样可能移除包含选区的行。

---

## 3. 修复计划（用户已确认按 1-2-3-4 全做）

### Step 1 — 选区/拖拽期间抑制自动分页（止血，行为层）

- 在 `MessageList` 内维护 `isPointerSelectingRef`：滚动容器上 `pointerdown`（主键）置位，`pointerup` / `pointercancel`（`document` 兜底）复位。
- 新增纯函数 `hasActiveTextSelectionWithin(root: Node): boolean`：`window.getSelection()` 存在、`!isCollapsed`、且 range 与滚动容器相交。优先放在 `packages/client/src/lib/clipboard.ts` 并复用/导出已有的 `rangeIntersectsRoot`，避免重复实现。
- `handleScroll` 的自动 `loadOlder` 分支在上述任一为真时跳过，并把"欠一次加载"记进 `pendingAutoLoadOlderRef`。
- `pointerup` 时若选区已折叠且仍处于 `scrollTop < 200`，补做一次 `loadOlder()`。
- 用户显式点击 "Load older messages" 按钮的路径**不受限制**（明确意图优先）。

### Step 2 — turn 行 key 在 prepend / append 下都稳定（根因）

**方案 A（推荐）：sticky turn key registry**

- `buildMessageRows` 增加可选参数 `resolveTurnKey?: (group) => string`，默认行为保持现状（不破既有调用与测试）。
- `MessageList` 用 `useRef<Map<itemId, turnKey>>` 实现 resolver：某个 assistant group 若包含已登记的 item，则复用「该 group 内最早登记 item 对应的 key」；否则新分配 `turn-${firstItem.id}` 并登记该 group 全部 item id。
- 效果：prepend 只是把新 item 塞进同一行（React 按 item id reconcile，已有 DOM 节点原地保留 → 选区不被破坏）；append（流式）也不动历史行。
- registry 随 `sessionId` / `branchId` 重置，并裁剪已移出窗口的 item，避免无界增长。

**方案 B（复杂度不可接受时的退路）**

- key 改为「上一个边界 item id」派生：`turn-after-<userPromptId | answeredQuestionId>`，窗口起点处的半截 turn 用 `turn-head` 哨兵。
- 实现简单，但当 prepend 首次补全该 turn 的边界时仍会 remount 一次 → 属已知残留，必须在文档与测试里标注。

**决策点**：先按 A 实现；若 registry 清理逻辑在 review 中被认为风险偏高，再退回 B（此时 Step 1 仍能保证用户可见问题消失）。

同时确认这些依赖 key 的逻辑语义不变：`lastUpdatedAssistantTurnKey`（`MessageList.tsx:283-300`）、虚拟化 `getItemKey`（:310）、`turnHasTarget` / branch focus。

### Step 3 — 修好 prepend 的滚动补偿

- `MessageListProps.onLoadOlderMessages` 类型放宽为 `() => void | Promise<void>`（`SessionPage` 传入的 `loadOlderMessages` 本身已是 async，预期无逻辑改动）。
- `handleLoadOlder`：请求发起时把 `{ scrollTop, scrollHeight, firstRowKey }` 记进 `prependAnchorRef`；`await` 加载 promise 仅用于失败时清理 anchor。
- 新增 `useLayoutEffect`（依赖 `rows`）：检测到 prepend（有 anchor 且 `scrollHeight` 增大）后，用 `isProgrammaticScrollRef` 包裹执行 `container.scrollTop += scrollHeight - anchor.scrollHeight`，再用一次 rAF 做二次校正，随后清空 anchor。
- 删除现有失效的双 rAF 逻辑。
- 确认与 `ResizeObserver` 自动滚底逻辑（`MessageList.tsx:420-452`）不冲突：prepend 期间不得触发 `scrollToBottom`（向上滚后 `shouldAutoScrollRef` 已为 false，用测试固定这一行为）。

### Step 4 — 回归测试

- `messageRows.test.ts`
  - 合成 fixture 模拟"窗口 100 → 200"的 prepend：除新增行外所有 assistant-turn key 不变（含被补全的顶部 turn）。
  - key 仍唯一（覆盖 group 被"已回答 question"拆分的情况）。
  - 尾部 turn append 新 item 时 key 不变。
- `MessageList.test.tsx`
  - 存在非折叠选区（jsdom 构造 Range/Selection）或 pointer 按下时，滚到顶部不调用 `onLoadOlderMessages`；`pointerup` + 选区折叠后补调一次。
  - prepend 前后同一 turn 的 DOM 节点实例保持不变（`expect(nodeBefore).toBe(nodeAfter)`）。
  - prepend 后 `scrollTop` 按 `scrollHeight` 差值补偿（用 `Object.defineProperty` 桩化 `scrollHeight` / `clientHeight`）。
- 脚本复验（需授权，见 §6）：重跑 `/tmp/selprobe/repro.mjs`、`/tmp/selprobe/repro3.mjs`。

---

## 4. 涉及文件

| 文件 | 改动 |
| ---- | ---- |
| `packages/client/src/components/MessageList.tsx` | pointer/选区守卫、sticky turn key registry、prepend 滚动锚定、props 类型 |
| `packages/client/src/components/messageRows.ts` | `buildMessageRows` 支持可选 `resolveTurnKey`，key 推导抽函数 |
| `packages/client/src/lib/clipboard.ts` | 导出 `hasActiveTextSelectionWithin`（复用 `rangeIntersectsRoot`） |
| `packages/client/src/pages/SessionPage.tsx` | 仅在 typecheck 需要时同步 props 类型 |
| `packages/client/src/components/__tests__/messageRows.test.ts` | 新增 key 稳定性用例 |
| `packages/client/src/components/__tests__/MessageList.test.tsx` | 新增守卫 / DOM 复用 / 滚动补偿用例 |
| `CHANGELOG.md` | `[Unreleased]` 增加 fix 条目 |

不改动：i18n 语言包（无新文案）、服务端、虚拟化阈值（后续项）。

---

## 5. 实施步骤（可逐步回滚）

1. 确认工作树：只改本任务相关文件，`git status` 中既有的无关改动保持不动。
2. Step 1a：`isPointerSelectingRef` + pointer 监听（含完整 cleanup）。
3. Step 1b：`hasActiveTextSelectionWithin` 落地。
4. Step 1c：`handleScroll` 守卫 + `pendingAutoLoadOlderRef` + `pointerup` 补做。
5. Step 1d：跑 `pnpm --filter @yep-anywhere/client test -- MessageList`，确认既有用例未回归。
6. Step 2a：`buildMessageRows` 增加可选 `resolveTurnKey`（默认行为不变）。
7. Step 2b：sticky registry 实现 + 重置/裁剪。
8. Step 2c：核对所有依赖 key 的逻辑语义不变。
9. Step 3a：放宽 `onLoadOlderMessages` 类型。
10. Step 3b：重写 `handleLoadOlder` + 新增 prepend 锚定 `useLayoutEffect`，删除失效逻辑。
11. Step 3c：核对与 `ResizeObserver` 自动滚底逻辑无冲突。
12. Step 4a/4b：补测试。
13. Step 4c：`pnpm lint`、`pnpm typecheck`、`pnpm test`。
14. Step 4d：更新 `CHANGELOG.md` 的 `[Unreleased]`。
15. Step 4e：申请浏览器复验实例（§6），获授权后重跑复现脚本并贴前后对比数据。

---

## 6. 风险与边界

- **服务约束（需用户授权）**：`8022` 实例跑的是已构建 bundle，浏览器复验需要跑到新代码。按 AGENTS.md 不得擅自重启/部署 `8022`；方案是另起一个 `PORT=<空闲端口> pnpm dev` 的**临时 dev server**（不动现有服务），需用户明确同意后执行。
- **sticky registry 正确性**：若一个 group 因新出现的"已回答 question"被拆成两段，必须只让包含最早登记 item 的那段继承旧 key，另一段新分配，否则出现重复 key（测试覆盖）。
- **内存**：registry 必须随 session/branch 重置并裁剪已移出窗口的 item。
- **活跃会话 window trim**：`planActiveMessageWindowTrim` 从顶部裁剪等价于反向 prepend，仍可能移除含选区的行；本次至少保证未被裁掉的行不受影响，活跃会话下的选区保护记为后续项。
- **滚动补偿必须标记 programmatic**，否则会把 `followingBottom` 误置为 true 或触发 `scrollToBottom`。
- **jsdom 局限**：不实现真实布局与 Chrome 的 Range 修复语义，单测只能验证"守卫是否生效、DOM 是否复用、scrollTop 是否按桩化高度补偿"，真实选区行为必须靠 Playwright/CDP 脚本复验。
- **体验回归**：误判"有选区"会让用户觉得加载不动 → 保留显式按钮 + `pointerup` 后补做一次加载。
- **虚拟化残留**：rows > 80 时行卸载仍可能破坏选区（Step 2 会改善 key，但卸载本身仍在）；记为后续项。

---

## 7. 验收标准

1. 长会话页面拖选文本并向上滚动时，不再自动加载旧消息；选区保持用户所选范围，Cmd+C 与 turn 复制按钮的结果与选中范围一致。
2. assistant-turn key 在 prepend 与 append 下都不变化（vitest 断言）；prepend 后同一 turn 的 DOM 节点实例保持不变（vitest 断言）。
3. 加载旧消息后视口内容位置基本不动（浏览器复验位移 < 5px，当前为 +19982px），且不会把 `followingBottom` 误置为 true。
4. `pnpm lint`、`pnpm typecheck`、`pnpm test` 全绿；不跑 `pnpm test:e2e`（本改动无 E2E 覆盖面）。
5. `CHANGELOG.md` `[Unreleased]` 已记录；未新增/修改界面文案；未触碰 `8022` 现有服务。
6. 交付报告列出浏览器复验前后数据对比与残留风险（活跃会话 window trim、rows > 80 虚拟化卸载）。

---

## 8. 实施结果（2026-08-17）

### 8.1 落地内容

| Step | 状态 | 实现 |
| ---- | ---- | ---- |
| 1 选区/拖拽期间抑制自动分页 | ✅ | `MessageList` 新增 `isPointerSelectingRef`（仅 mouse/pen，touch 排除以免影响移动端滚动）+ `hasActiveTextSelectionWithin`（`lib/clipboard.ts`，复用 `rangeIntersectsRoot`）；命中守卫时记 `pendingAutoLoadOlderRef`，在 `pointerup` / `pointercancel` / `selectionchange`（选区清空）后补做一次。显式点 "Load older messages" 按钮不受限制 |
| 2 turn key 稳定 | ✅ | 采用计划里的方案 A：`createStickyTurnKeyResolver(registry)` + `pruneTurnKeyRegistry`（`messageRows.ts`，纯函数、可单测）；registry 存 item id → turn key，随 `transcriptKey`（`sessionId:branchId`，`SessionPage` 传入）重置；turn 因"已回答 question"拆分时只有含最早登记 item 的那半继承旧 key |
| 3 prepend 滚动补偿 | ✅ | `onLoadOlderMessages` 类型放宽为 `() => void \| Promise<void>`；发起请求时用 `findPrependAnchorElement` 记录视口顶端**最深**元素的 `rect.top`，在 rows commit 的 `useLayoutEffect` 里按该元素的位移做**相对**补偿；锚点生命周期跟随 `loadingOlder`，用户等待期间继续滚动会刷新锚点 |
| 4 回归测试 | ✅ | `messageRows.test.ts` +4（prepend/append key 稳定、拆分唯一性、registry 裁剪）；`MessageList.test.tsx` +5（正常自动加载、选区期间不加载+清空后补做、prepend 后 DOM 节点复用、transcript 切换重置身份、滚动补偿 & 不重复补偿）。5 条新用例都做过 mutation 验证（关掉对应实现即失败） |

### 8.2 实施中发现的三个额外坑（计划里没预见）

1. **原生 scroll anchoring 会和手动补偿叠加**：key 修好后 Chrome 自己的 anchoring 开始生效，"scrollTop += heightDelta" 变成双倍补偿（实测 181 → 43600，应为 21890）。改成"按锚点元素位移做相对补偿"后天然幂等（Chrome 已补则 delta≈0；WebKit 无 anchoring 则我们补）。
2. **行级锚点不够细**：旧消息有一部分是 prepend 到顶部那个 turn **内部**的，用行元素当锚点会残留误差（实测 21709px 里有 1214px 没被补偿）。改成 `elementFromPoint` 取视口顶端最深元素（并排除 `.message-list` 自身与 `.load-older-messages` 行，横向采样 25%/50%/75% 以避开 timeline gutter）。
3. **锚点过期策略不能用 rAF**：大批 prepend 的 React commit 常常晚于 2 帧；且 1px 的无关 reflow 会提前消耗锚点。改为跟随 `loadingOlder` 生命周期 + `PREPEND_MIN_HEIGHT_GROWTH = 8` 阈值。

### 8.3 浏览器复验（Chrome headless，系统 channel）

复验方式不启动任何 yep 服务：`BASE_PATH=/yep vite build` 出静态包，用 `/tmp/selprobe/serve.mjs` 托管并把 `/yep/api/*` 只读代理到运行中的 `8022`（未重启、未改动该服务）。脚本：`/tmp/selprobe/verify.mjs`、`verify-top-once.mjs`。

| 场景 | 修复前 | 修复后 |
| ---- | ------ | ------ |
| 拖选后向上滚（触发阈值） | 选区归零、`anchorNode = .message-list@1`、移除 1 个 `.assistant-turn`、随后误选 442 字符 | 选区保持（10 字符，anchor 仍是原文本节点）、`removedRows: []`、**older-message 请求 0 次** |
| 选区清空后 | — | 延迟的加载补做（请求 1 次），`removedRows: []` |
| 加载旧消息（`scrollTop=101`） | 标记行位移 +19982px | 标记行位移 **+1px**，prepend 23151px，scrollTop 101 → 23251 |
| 加载旧消息（`scrollTop=0`，原生 anchoring 失效档） | 标记行位移 +21709px | 标记行位移 **0px**，scrollTop 0 → 23151 |
| 已有行 DOM | 每次加载移除 1 个 turn 子树 | `removedRows: 0`，原有 22/25 行全部保留 |

### 8.4 校验

- `packages/client` `tsc --noEmit`：通过
- `pnpm lint`（biome，1148 文件）：通过
- 客户端 vitest 全量：99 文件 / 837 用例通过
- 仓库级 `pnpm typecheck` 当时因**另一个并行会话**在改 `packages/server`（`llm-gateways` 相关，未提交）而失败，与本次改动无关，未触碰其文件

### 8.5 残留风险

- **行数 > 80 时虚拟化仍会卸载行**：复验中连续多次加载让 rows 超过 80，虚拟化启用后出现大规模 remount（选区同样会丢）。本次未处理，属已知残留。
- 拖选时用滚轮滚动，选区仍会跟着光标扩展到光标所指位置——这是浏览器原生行为（锚点已保留、可逆），与原 bug（锚点被销毁、复制内容错乱）不同。
- 活跃会话的 `planActiveMessageWindowTrim` 从顶部裁剪消息仍可能移除含选区的行。
- 移动端触屏未纳入 pointer 守卫（避免破坏触摸滚动分页），触屏依赖 `hasActiveTextSelectionWithin` 兜底。

---

## 9. 部署后复测与两条追加修复（2026-08-17，第二轮）

在用户重新部署（buildId `2026.8.4-b334d66b64e1-20260817122050`）后对 `8022` 做只读复测，原始问题已修复；同时发现两个更细的 remount 源，已一并修掉（**这两条不在上述部署版里，需要再部署一次**）。

### 9.1 部署版复测结论（原始问题）

| 场景 | 结果 |
| ---- | ---- |
| 选中文本 → 向上滚动 960px → `Cmd+C` | 选区不变，剪贴板 === 选中文本；`removedRows: []`；加载请求 0 次（被延迟） |
| 无选区时滚动到顶部自动加载 | 正常加载（1 次请求），已有行 0 移除，视口位移仅等于用户自己滚的 40px |
| 连续加载（`scrollTop=0` / `100`） | 补偿精确：0px / +1px（修复前 +21709px / +19982px） |

### 9.2 追加修复 A：虚拟化模式在有选区时不切换

- 现象：连续加载让 rows 越过 `VIRTUALIZE_ROW_THRESHOLD = 80` 时，虚拟化启用会把整张列表换成虚拟窗口（实测 rows 28 → 9 个 DOM 子节点、大量 `removedNodes`、`scrollHeight` 变成估算值 34064），选区随之丢失。
- 修复：新增 `hasActiveSelection` state（`selectionchange` 驱动），`shouldVirtualize = hasActiveSelection ? virtualizeEnabledRef.current : wantsVirtualization`——有选区时冻结当前模式（与既有 `focusBranchId` / `targetMessageId` 抑制同一套模式）。
- 为降低 `selectionchange` 频繁触发的成本，`hasActiveTextSelectionWithin` 去掉了 `selection.toString()`，只判断 `isCollapsed` + range 与容器相交。

### 9.3 追加修复 B：`TextBlock` 不再用相同 HTML 重刷 markdown 容器

- 定位过程：MutationObserver 显示 `.assistant-turn` 与 `.text-block` 都还在，只有 `dangerouslySetInnerHTML` 容器的**子节点**被整体替换；patch `Element.prototype.innerHTML` 的 setter 抓到调用来自 React，且两次写入的字符串 **完全相同**（`pairIdentical: true`，长度均 4078）。也就是说 React 在 prepend commit 上重新应用了这个 prop，导致容器内所有节点（包含选区锚点 `<p>`）被重建。
- 修复：改为在 `useLayoutEffect` 里手写 `host.innerHTML`，并用 `appliedAugmentRef` 记录「已应用到哪个 host 的哪段 HTML」，相同内容直接跳过；HTML 真的变化或 host 换节点时才重写。
- 附带：滚动、空闲状态下不会发生这种重刷（实测 `applied: 0`），所以该问题只在 prepend commit 时出现。

### 9.4 追加修复的验证

本地静态包（`vite build` + 只读代理到 `8022`）上，"按住选区连续点 Load older messages" 场景：

```
selected: "这是两天来 v2 成果第一次存在于产品" len: 19
round 1: rows=48 virtualWrappers=0 removedNodes=0 selLen=19 selMatches=true
round 2: rows=60 virtualWrappers=0 removedNodes=0 selLen=19 selMatches=true
round 3: rows=71 virtualWrappers=0 removedNodes=0 selLen=19 selMatches=true
round 4: rows=82 virtualWrappers=0 removedNodes=0 selLen=19 selMatches=true   ← 越过 80 阈值仍未切虚拟化
round 5: rows=82 virtualWrappers=0 removedNodes=1 selLen=19 selMatches=true   ← 移除的是 load-older 行本身
clipboard len: 19 | RESULT: clipboard === original selection ✔
```

修复前同一脚本：`round 1` 起 `selLen=0`、剪贴板为空。

### 9.5 校验（第二轮）

- `packages/client` `tsc --noEmit`：通过
- `npx biome check .`（1148 文件）：通过
- 客户端 vitest 全量：99 文件 / **840** 用例通过（新增 TextBlock 2 条、MessageList 虚拟化守卫 1 条）
- 说明：`TextBlock` 的两条 jsdom 用例只能守住"内容正确 + HTML 变化时会更新"，"相同 HTML 不重刷"的判别性证据来自上面的浏览器测量（jsdom 里 React 会自行跳过相同字符串，无法复现该 commit 路径）

### 9.6 仍未处理

- 已处于虚拟化模式时（超长会话首屏即 >80 行）滚动仍会卸载行，此时新建选区跨出虚拟窗口仍会丢；根治需要更细的行粒度或"选区附近保持挂载"。
- 活跃会话 `planActiveMessageWindowTrim` 从顶部裁剪仍可能移除含选区的行。
- 触屏路径不参与 pointer 守卫（避免破坏触摸滚动分页），依赖选区判断兜底。
