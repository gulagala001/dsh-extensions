# Session-owned Claude command hooks

Extensions remains the sole dispatcher. Keep `dsh-claude-compat.enableHooks: false`; do not mount `dsh-hooks-claude-code` as another engine. The native hook-protocol runner/codec/merge are library dependencies only. Requires native rc.5 plus the reviewed `PreToolDecision.updatedInput` patch.

Runtime dependency: `platformProjectConfig.resolve(agent,signal)` returns verified source and execution roots plus actual preset-owned fs/subprocess/sandbox/shell/sandboxPolicy. Its `writeState(agent,'transcript.jsonl',text,signal)` writes the derived Claude-format protocol projection into configured private executor state. It does not create or replace a native Session. Missing executor state configuration is an activation error, not permission to write into the Host home or a repository.

Sources are user `.claude/settings.json` only under the explicit executor user configuration root, then project `.claude/settings.json`, then project `.claude/settings.local.json`. Worktree command cwd is separate from this stable source root. Local legacy DSH hooks remain an additional source only for unbound local sessions. Changes are read through the bound filesystem at the next event. Imported files are never copied over canonical Claude files.

Command hooks support shell and argv forms, per-command timeout, async/asyncRewake, once, tool aliases, context, blocking, native ask, updatedInput, and skill invocation-scoped registration. `Hooks.registerSkill(agent,{id,source,pluginRoot,hooks})` returns its disposer. The native skill adapter owns admission and removal; the dispatcher does not register a second event pipeline.

SessionStart runs at first admitted turn before its model request. Stop uses actual `stop_hook_active`, carries feedback, and has no arbitrary three-continuation cutoff; cancellation still terminates work. SessionEnd cleanup is registered after preset setup and drains before provider teardown; it cannot request approval outside an open turn. Git Bash IPC initialization failure can request one native approval for one retry of that exact configured command. No session-wide permissions, persistent grants, Host process fallback, or additional retry loop is installed.

Non-command hook types are rejected explicitly. They are not silently omitted or run through paid model calls. Actual deployment, VM provisioning, physical phone pairing and live installation changes are separate activation work.
