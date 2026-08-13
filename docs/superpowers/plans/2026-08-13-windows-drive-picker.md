# Windows Drive Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the project folder picker start at all accessible mounted Windows drive roots.

**Architecture:** The filesystem browse route gains a Windows-only virtual root represented by an empty response path. It discovers mounted drive roots by checking `A:\` through `Z:\`; directory responses for a drive root point back to the virtual root. The existing modal treats an empty parent as a valid navigation target and labels the empty current path as the localized drive list.

**Tech Stack:** TypeScript, Hono, Node.js `fs/promises`, React, Vitest.

## Global Constraints

- Keep macOS and Linux behavior unchanged: an empty browse request opens the server user's home directory.
- Do not alter the project-add API or session working-directory behavior.
- Include local, removable, and mapped-network drives when they are mounted and accessible to the server process.

---

### Task 1: Add the Windows virtual-root route behavior

**Files:**
- Modify: `packages/server/src/routes/fs-browse.ts`
- Test: `packages/server/src/routes/fs-browse.test.ts`

**Interfaces:**
- Produces: `GET /browse` returns `{ path: "", parent: null, entries }` on Windows.
- Produces: `GET /browse?path=C:\` returns `parent: ""` on Windows.

- [ ] **Step 1: Write failing route tests**

```ts
it("lists accessible Windows drive roots at the virtual root", async () => {
  const app = createFsBrowseRoutes({
    platform: "win32",
    pathExists: async (path) => path === "C:\\" || path === "D:\\",
  });
  const res = await app.request("/browse");
  expect(await res.json()).toMatchObject({
    path: "",
    parent: null,
    entries: [{ name: "C:", path: "C:\\" }, { name: "D:", path: "D:\\" }],
  });
});
```

- [ ] **Step 2: Run the route test and confirm it fails because the virtual root is missing**

Run: `pnpm --filter server test src/routes/fs-browse.test.ts`

- [ ] **Step 3: Implement minimal drive discovery**

```ts
for (let code = 65; code <= 90; code++) {
  const path = `${String.fromCharCode(code)}:\\`;
  if (await pathExists(path)) entries.push({ name: path, path, isDirectory: true });
}
```

- [ ] **Step 4: Run the route test and confirm it passes**

Run: `pnpm --filter server test src/routes/fs-browse.test.ts`

### Task 2: Let the picker return to and label the drive list

**Files:**
- Modify: `packages/client/src/components/FolderBrowserModal.tsx`
- Modify: `packages/client/src/i18n/en.json`
- Modify: `packages/client/src/i18n/zh-CN.json`
- Modify: `packages/client/src/i18n/de.json`
- Modify: `packages/client/src/i18n/es.json`
- Modify: `packages/client/src/i18n/fr.json`
- Modify: `packages/client/src/i18n/ja.json`

**Interfaces:**
- Consumes: browse response `path: ""` and `parent: ""`.
- Produces: the Up button calls the no-path browse endpoint for `parent === ""`.

- [ ] **Step 1: Update navigation conditions**

```tsx
const goUp = () => {
  if (parent !== null) void load(parent);
};
```

- [ ] **Step 2: Display the localized drive-list label for an empty current path**

```tsx
{currentPath === "" ? t("folderBrowseDrives") : (currentPath ?? "…")}
```

- [ ] **Step 3: Add `folderBrowseDrives` to every maintained locale**

```json
"folderBrowseDrives": "Drives"
```

### Task 3: Verify the focused change

**Files:**
- Verify: `packages/server/src/routes/fs-browse.test.ts`
- Verify: TypeScript and Biome workspace checks

- [ ] **Step 1: Run focused tests**

Run: `pnpm --filter server test src/routes/fs-browse.test.ts`

- [ ] **Step 2: Run static checks**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 3: Inspect the diff for scope**

Run: `git diff --check && git diff -- packages/server/src/routes/fs-browse.ts packages/server/src/routes/fs-browse.test.ts packages/client/src/components/FolderBrowserModal.tsx packages/client/src/i18n`
