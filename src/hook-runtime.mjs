import { posix, win32 } from 'node:path';
import { runHook, mergeHookOutputs } from '@deepseek-ai/dsh-hook-protocol';
import { approveEscalation } from '@deepseek-ai/dsh-sandbox';

export { mergeHookOutputs };
export const TOOL_ALIASES = Object.freeze({ bash: 'Bash', pwsh: 'PowerShell', read: 'Read', edit: 'Edit', write: 'Write',
  glob: 'Glob', grep: 'Grep', web_fetch: 'WebFetch', web_search: 'WebSearch', subagent: 'Task',
  todo_write: 'TodoWrite', ask_user_question: 'AskUserQuestion', enter_plan_mode: 'EnterPlanMode', exit_plan_mode: 'ExitPlanMode',
  create_worktree: 'EnterWorktree', worktree: 'EnterWorktree', skill: 'Skill' });
const absent = error => ['FS_NOT_FOUND', 'ENOENT', 'ENOTDIR'].includes(error?.code);
const aliases = name => Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name;
const paths = context => context.executorId ? posix : process.platform === 'win32' ? win32 : posix;

export async function hookSources(ctx, agent, signal, legacyFile) {
  const context = await ctx.platformProjectConfig.resolve(agent, signal);
  const path = paths(context);
  const files = [];
  if (!context.executorId && legacyFile) files.push({ file: legacyFile, projectDir: context.checkoutRoot });
  if (context.userConfigRoot) files.push({ file: path.join(context.userConfigRoot, '.claude/settings.json'), projectDir: context.checkoutRoot });
  files.push({ file: path.join(context.checkoutRoot, '.claude/settings.json'), projectDir: context.checkoutRoot },
    { file: path.join(context.sourceRoot, '.claude/settings.local.json'), projectDir: context.sourceRoot });
  // The pre-existing DSH file remains a source on an unbound local installation;
  // a remote project never reaches back into the control host's filesystem.
  const documents = [];
  const seenFiles = new Set();
  for (const { file, projectDir } of files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    try {
      const target = await context.fs.resolve(file, { cwd: context.sourceRoot, signal });
      const stat = await context.fs.stat(target, signal);
      if (!stat) continue;
      if (stat.type !== 'file') throw new Error(`Hook settings are not a regular file: ${file}`);
      const value = JSON.parse(await context.fs.readText(target, signal));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid hook settings: ${file}`);
      if (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw new Error(`Invalid hooks object: ${file}`);
      documents.push({ file: context.fs.processPath(target), projectDir, document: value });
    } catch (error) { if (!absent(error)) throw error; }
  }
  const env = {};
  for (const { document } of documents) for (const [key, value] of Object.entries(document.env ?? {})) {
    if (typeof value === 'string' && !key.startsWith('DSH_')) env[key] = value;
  }
  return { context: { ...context, hookEnv: env }, documents };
}

export function selectedHooks(documents, event, value, matches) {
  let disabled = false;
  const selected = new Map();
  for (const { file, document, pluginRoot, projectDir } of documents) {
    if (typeof document.disableAllHooks === 'boolean') disabled = document.disableAllHooks;
    for (const group of document.hooks?.[event] ?? []) {
      if (['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'].includes(event)
        && !matches(group.matcher, aliases(value))) continue;
      for (const hook of group.hooks ?? []) {
        if (hook.enabled === false) continue;
        if ((hook.type ?? 'command') !== 'command') throw new Error(`Unsupported ${hook.type} hook in ${file}; it was not silently skipped`);
        if (typeof hook.command !== 'string' || !hook.command.trim()) throw new Error(`Invalid command hook in ${file}`);
        const key = JSON.stringify([hook.command, hook.args ?? null, hook.shell ?? null]);
        if (hook.shell !== undefined && !['bash', 'powershell'].includes(hook.shell)) throw new Error(`Invalid hook shell in ${file}`);
        selected.set(key, { ...hook, source: file, projectDir, ...(pluginRoot ? { pluginRoot } : {}) });
      }
    }
  }
  return disabled ? [] : [...selected.values()];
}

// Execute argv only through the selected realm's native process/sandbox seams.
// An explicit command invocation never falls back to node:child_process on Host.
async function argvResult(context, spec, hook, policy) {
  const localWindows = !context.executorId && process.platform === 'win32';
  let argv;
  if (hook.args !== undefined) {
    if (!Array.isArray(hook.args) || hook.args.some(value => typeof value !== 'string')) throw new Error('Hook args must be strings');
    argv = [await context.subprocess.resolveExecutable(hook.command, spec.env, spec.signal), ...hook.args];
  } else if (hook.shell === 'powershell') {
    argv = [await context.subprocess.resolveExecutable('pwsh', spec.env, spec.signal), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', spec.command];
  } else if (localWindows) {
    // Never resolve Windows' WSL bash shim as Git Bash. An explicit Claude path
    // or the standard native Git installation must exist in this local realm.
    const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH,
      process.env.ProgramFiles && win32.join(process.env.ProgramFiles, 'Git/bin/bash.exe'),
      process.env.LOCALAPPDATA && win32.join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')].filter(Boolean);
    let bash;
    for (const candidate of candidates) {
      const target = await context.fs.resolve(candidate, { signal: spec.signal });
      if ((await context.fs.stat(target, spec.signal))?.type === 'file') { bash = context.fs.processPath(target); break; }
    }
    if (!bash) throw new Error('Git Bash is required by this Claude hook; configure CLAUDE_CODE_GIT_BASH_PATH');
    argv = [bash, '-c', spec.command];
  } else argv = [await context.subprocess.resolveExecutable(hook.shell === 'bash' ? 'bash' : 'sh', spec.env, spec.signal), '-c', spec.command];
  const deadline = AbortSignal.timeout(spec.timeoutMs);
  const signal = AbortSignal.any([deadline, spec.signal]);
  const confined = policy.mode === 'danger-full-access' ? null : await context.sandbox.confine(argv, policy, signal);
  const child = context.subprocess.spawn({ argv: confined?.argv ?? argv, cwd: spec.workdir,
    stdio: { stdin: { data: spec.stdin ?? '' }, stdout: { maxBytes: spec.stdoutMaxBytes }, stderr: { maxBytes: spec.stdoutMaxBytes } },
    env: spec.env, graceMs: 3000, signal });
  const outcome = await child.done;
  return { exitCode: outcome.exitCode, signal: outcome.signal, timeoutMs: spec.timeoutMs,
    timedOut: deadline.aborted && !spec.signal.aborted, aborted: spec.signal.aborted,
    stdout: { text: child.collected.stdout.readFrom(0).text }, stderr: { text: child.collected.stderr.readFrom(0).text } };
}

export async function executeHook(ctx, agent, context, hook, input, { signal, event, callId, allowApproval = true }) {
  const access = ctx.get('platformAccess');
  if (access) access.assertContext(access.resolveExecution(agent), 'write');
  const projectDir = hook.projectDir ?? context.checkoutRoot;
  const substitute = value => value.replaceAll('${CLAUDE_PROJECT_DIR}', projectDir)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', hook.pluginRoot ?? '${CLAUDE_PLUGIN_ROOT}');
  const command = hook.args !== undefined ? substitute(hook.command) : hook.shell === 'powershell'
    ? hook.command.replace(/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT)\}/g, '${env:$1}') : hook.command;
  const normalized = { ...hook, command, ...(hook.args ? { args: hook.args.map(substitute) } : {}) };
  const standing = context.sandboxPolicy.resolve({ session: agent.session });
  let policy = standing;
  let raw;
  const executor = {
    resolve(request) { return context.shell.resolve({ ...request, sandboxPolicy: policy }); },
    async execute(spec) { return { result: async () => (raw = await argvResult(context, spec, normalized, policy)) }; },
  };
  const options = { payload: { ...input, tool_name: input.tool_name ? aliases(input.tool_name) : undefined },
    env: { ...context.hookEnv, DSH_PROJECT_DIR: context.cwd, CLAUDE_PROJECT_DIR: projectDir, ...(hook.pluginRoot ? { CLAUDE_PLUGIN_ROOT: hook.pluginRoot } : {}) },
    cwd: context.cwd, signal, trailingNewline: true, expectedEventName: event, defaultTimeoutMs: 600000 };
  const run = () => runHook(executor, { command, ...(hook.timeout ? { timeoutSec: hook.timeout } : {}) }, options, Date.now);
  let result = await run();
  // This signature proves MSYS failed before the requested program started.
  // Escalation is a native, one-invocation question, never a persistent grant.
  const msysFailure = !context.executorId && process.platform === 'win32' && raw?.exitCode !== 0
    && /couldn't create (?:signal )?pipe[^\n]*(?:Win32 error 5|Access is denied)/i.test(raw?.stderr?.text ?? '');
  if (msysFailure && standing.mode !== 'danger-full-access') {
    if (!allowApproval) throw new Error(`${event} hook could not start under Windows confinement; no approval is available outside an open turn`);
    const mode = await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: standing.mode,
      subject: 'command', justification: `Run this configured ${event} hook once because Git Bash cannot initialize its IPC under the Windows restricted token: ${command}` },
    { approver: ctx.get('approval'), agent, callId, toolName: `hook:${event}`, signal });
    policy = { ...standing, mode };
    result = await run();
  }
  signal.throwIfAborted();
  // A failed spawn/timeout must not masquerade as a successfully checked gate.
  if (result.output.exitCode === undefined || raw?.timedOut || raw?.aborted) throw new Error(result.output.stderr || `${event} hook did not complete`);
  return { ...raw, code: raw.exitCode, stdout: raw.stdout.text, stderr: raw.stderr.text, output: result.output, durationMs: result.durationMs };
}

export async function transcript(ctx, agent, signal) {
  const messages = agent.session.deriveMessages();
  const blocks = content => content.flatMap(block => {
    if (block.type === 'tool-call') {
      let input;
      try { input = JSON.parse(block.arguments); } catch { input = { raw: block.arguments }; }
      return [{ type: 'tool_use', id: block.id, name: aliases(block.name), input }];
    }
    if (block.type === 'reasoning') return [{ type: 'thinking', thinking: block.text ?? '' }];
    if (block.type === 'text' || block.type === 'image') return [block];
    return [{ type: 'text', text: `[native ${block.type}] ${JSON.stringify(block)}` }];
  });
  const rows = messages.map((message, index) => ({ type: message.role === 'assistant' ? 'assistant' : 'user',
    uuid: String(message.id), sessionId: agent.session.id, native_role: message.role,
    parentUuid: index ? String(messages[index - 1].id) : null,
    message: { role: message.role === 'assistant' ? 'assistant' : 'user', content: message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.toolCallId, is_error: message.isError === true, content: blocks(message.content) }]
      : blocks(message.content) } }));
  const path = await ctx.platformProjectConfig.writeState(agent, 'transcript.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n', signal);
  const last = [...messages].reverse().find(message => message.role === 'assistant');
  return { transcript_path: path, last_assistant_message: (last?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n') };
}
