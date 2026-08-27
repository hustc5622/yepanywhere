Read and follow `CLAUDE.md` for repo context and instructions.

## Git Worktree Policy

- Work in the existing local checkout by default; use a short-lived branch there when isolation is needed.
- Do not create a Git worktree unless the user explicitly authorizes it. Ask first when parallel or production-sensitive work would benefit from one.
- After integration, remove any authorized worktree and prune its Git registration.

## Landing the Plane (Session Completion)

After completing your session, offer proactively, briefly, a suggestion
to the user for what the next logical step in the plan might be, to remind
them of the overall context if this session was a part of a larger implementation plan
