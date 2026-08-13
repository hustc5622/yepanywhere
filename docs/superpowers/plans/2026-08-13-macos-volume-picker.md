# macOS Volume Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the macOS system disk and mounted `/Volumes` entries in the project-folder picker.

**Architecture:** Extend the existing virtual drive root in `fs-browse.ts`. On `darwin`, the route lists `/` and accessible direct children of `/Volumes`, and returns the virtual root as the parent for those roots. The existing frontend already supports the virtual-root sentinel.

**Tech Stack:** TypeScript, Hono, Node.js `fs/promises`, Vitest.

## Global Constraints

- Preserve deployed Windows drive discovery and Linux home-directory behavior.
- Include only the macOS system root and direct `/Volumes` mount points.
- Do not change project or session APIs.

---

### Task 1: Add macOS volume route tests and implementation

**Files:**
- Modify: `packages/server/src/routes/fs-browse.test.ts`
- Modify: `packages/server/src/routes/fs-browse.ts`

- [ ] **Step 1: Write failing tests for a virtual macOS root**

```ts
const app = createFsBrowseRoutes({
  platform: "darwin",
  readDirectories: async (path) => path === "/Volumes" ? ["External"] : [],
  pathExists: async () => true,
});
expect(await (await app.request("/browse")).json()).toMatchObject({
  path: "",
  entries: [{ path: "/" }, { path: "/Volumes/External" }],
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter server test src/routes/fs-browse.test.ts`

- [ ] **Step 3: Implement direct `/Volumes` listing and virtual-root parents**

```ts
if (platform === "darwin") {
  return [{ name: "/", path: "/", isDirectory: true }, ...volumes];
}
```

- [ ] **Step 4: Run focused tests and confirm success**

Run: `pnpm --filter server test src/routes/fs-browse.test.ts`

### Task 2: Verify and deploy

**Files:**
- Verify: route tests and static checks

- [ ] **Step 1: Run checks**

Run: `pnpm --filter server test src/routes/fs-browse.test.ts && pnpm --filter server exec tsc --noEmit && pnpm --filter client exec tsc --noEmit && pnpm lint`

- [ ] **Step 2: Deploy the approved production change**

Run: `pnpm yep rebuild`
