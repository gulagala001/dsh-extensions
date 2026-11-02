import { hookSources, selectedHooks, executeHook, transcript, mergeHookOutputs } from './hook-runtime.mjs';
import { appendHookInvoked, appendHookResult, parseHookOutput } from '@deepseek-ai/dsh-hook-protocol';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { errorText, fail, tilde, trimTo, writeAtomic } from './common.mjs';

export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'];
export const MATCHER_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'];
const RUN_HISTORY = 50;

/** Exact names, `a|b` alternatives and regular expressions all match the whole value. */
export function matches(matcher, value) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(value ?? ''); } catch { return matcher === value; }
}

/** Read one finished run with the exit-code and JSON conventions common to coding-agent hooks. */
export function interpret(event, run) {
  const result = { block: false, halt: false, reason: '', context: '', permission: null };
  if (run.output) {
    const output = run.output;
    result.block = run.code === 2 || output.decision === 'block';
    result.halt = output.continue === false;
    result.reason = output.reason || output.stopReason || (run.code === 2 ? output.stderr : '');
    result.permission = ['allow', 'deny', 'ask'].includes(output.decision) ? output.decision : null;
    result.context = output.additionalContext ?? (run.code === 0 && ['SessionStart', 'UserPromptSubmit'].includes(event) && !output.stdout.trim().startsWith('{') ? output.stdout.trim() : '');
    return result;
  }
  if (run.error || run.timedOut) return result;
  if (run.code === 2) return { ...result, block: true, reason: run.stderr.trim() };
  if (run.code !== 0) return result;
  const out = run.stdout.trim();
  let json = null;
  if (out.startsWith('{')) try { json = JSON.parse(out); } catch {}
  if (!json) return ['UserPromptSubmit', 'SessionStart'].includes(event) ? { ...result, context: out } : result;
  const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput : {};
  if (json.decision === 'block') Object.assign(result, { block: true, reason: String(json.reason ?? '') });
  if (json.continue === false) Object.assign(result, { halt: true, reason: result.reason || String(json.stopReason ?? '') });
  if (['allow', 'deny', 'ask'].includes(specific.permissionDecision)) {
    result.permission = specific.permissionDecision;
    result.reason ||= String(specific.permissionDecisionReason ?? '');
  } else if (event === 'PreToolUse' && json.decision === 'approve') result.permission = 'allow';
  if (typeof specific.additionalContext === 'string') result.context = specific.additionalContext;
  return result;
}

const hookSource = event => ({ kind: 'extension-hook', form: 'notice', summary: `${event} hook` });
const contextMessage = (event, text) => createUserMessage({ source: hookSource(event),
  content: [{ type: 'text', text: `<system-reminder>\n${event} hook additional context:\n${text}\n</system-reminder>` }] });
const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const subagent = agent => agent?.session?.header?.origin === 'subagent';
const valid = timeout => Number.isFinite(timeout) && timeout > 0 && timeout <= 600;

/** Command hooks from `$DSH_HOME/hooks.json`, attached to DSH's native agent and tool events. */
export class Hooks {
  constructor(ctx, homes) {
    this.ctx = ctx; this.file = join(homes.dsh, 'hooks.json');
    this.cache = { mtime: undefined, document: { hooks: {} }, error: null };
    this.runs = []; this.stops = new WeakMap(); this.starts = new WeakMap(); this.contexts = new WeakMap(); this.skills = new WeakMap();
    this.documents = new WeakMap(); this.projections = new WeakMap(); this.lifetimes = new WeakMap(); this.agentRuns = new WeakMap(); this.once = new WeakMap();
    this.queue = Promise.resolve(); this.running = new Set(); this.controller = new AbortController();
    ctx.effect(() => () => this.close());
  }
  async load({ force = false } = {}) {
    const mtime = await stat(this.file).then(info => info.mtimeMs, () => null);
    if (!force && mtime === this.cache.mtime) return this.cache;
    let document = { hooks: {} }, error = null;
    if (mtime !== null) {
      try {
        document = JSON.parse(await readFile(this.file, 'utf8'));
        if (!document || typeof document !== 'object' || Array.isArray(document)) throw Error('hooks.json must contain an object');
        document.hooks ??= {};
        if (typeof document.hooks !== 'object' || Array.isArray(document.hooks)) throw Error('"hooks" must be an object');
      } catch (failure) { document = { hooks: {} }; error = errorText(failure); }
    }
    this.cache = { mtime, document, error };
    return this.cache;
  }
  async matching(event, value, agent, signal = this.controller.signal) {
    if (!agent) throw new Error('A session is required to resolve hooks');
    const loaded = await hookSources(this.ctx, agent, signal, this.file);
    this.contexts.set(agent, loaded.context);
    this.documents.set(agent, loaded.documents);
    const scoped = [...(this.skills.get(agent)?.values() ?? [])].map(skill => ({ file: skill.source, pluginRoot: skill.pluginRoot, document: { hooks: skill.hooks } }));
    const consumed = this.once.get(agent);
    return selectedHooks([...loaded.documents, ...scoped], event, value, matches).filter(hook => !hook.once || !consumed?.has(JSON.stringify([event, hook.source, hook.command, hook.args])));
  }
  registerSkill(agent, definition) {
    if (!agent || typeof definition?.id !== 'string' || !definition.hooks || typeof definition.source !== 'string') throw new Error('Invalid skill-scoped hook registration');
    let scoped = this.skills.get(agent);
    if (!scoped) { scoped = new Map(); this.skills.set(agent, scoped); }
    if (scoped.has(definition.id)) throw new Error('Skill hook invocation is already registered');
    const hooks = subagent(agent) && definition.hooks.Stop ? { ...definition.hooks, SubagentStop: definition.hooks.Stop } : definition.hooks;
    scoped.set(definition.id, { ...definition, hooks });
    return () => { scoped.delete(definition.id); };
  }
  async execute(command, input, options) {
    const { agent, hook = { type: 'command', command }, event = input.hook_event_name } = options;
    if (!agent) throw new Error('Choose an actual session to run a hook');
    const signal = AbortSignal.any([options.signal ?? this.controller.signal, this.controller.signal]);
    const context = this.contexts.get(agent) ?? (await hookSources(this.ctx, agent, signal, this.file)).context;
    const task = executeHook(this.ctx, agent, context, hook, input, { signal, event, callId: input.tool_use_id, allowApproval: options.allowApproval ?? event !== 'SessionEnd' });
    this.running.add(task);
    try { return await task; } finally { this.running.delete(task); }
  }
  async close() {
    this.controller.abort(new Error('Extensions service is stopped'));
    await Promise.allSettled([...this.running, this.queue]);
  }
  async run(event, hooks, fields, { agent, signal = this.controller.signal } = {}) {
    const context = this.contexts.get(agent);
    if (!context) throw new Error('Session hook execution context is unavailable');
    const projection = event === 'SessionEnd' ? this.projections.get(agent) ?? {} : await transcript(this.ctx, agent, signal);
    this.projections.set(agent, projection);
    const input = { session_id: agent.session.id, cwd: context.cwd, hook_event_name: event,
      agent_type: subagent(agent) ? 'general-purpose' : 'main', ...(subagent(agent) ? { agent_id: agent.session.id, agent_transcript_path: projection.transcript_path } : {}), ...projection, ...fields };
    const invoke = async (hook, runSignal = signal) => {
      if (hook.once) {
        let consumed = this.once.get(agent);
        if (!consumed) { consumed = new Set(); this.once.set(agent, consumed); }
        consumed.add(JSON.stringify([event, hook.source, hook.command, hook.args]));
      }
      const journal = event !== 'SessionEnd' && !hook.async && !hook.asyncRewake;
      const handlerId = `extensions:${randomUUID()}`;
      const turn = journal ? this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary').lastTurn : undefined;
      if (journal) appendHookInvoked(agent.session, { turn, point: event, dialect: 'claude-code', handlerId });
      let run;
      try { run = await this.execute(hook.command, input, { agent, hook, event, signal: runSignal }); }
      catch (error) {
        if (journal) appendHookResult(agent.session, { turn, point: event, handlerId,
          output: parseHookOutput(undefined, '', errorText(error)), stderrSummaryMaxChars: 1000, durationMs: 0 });
        throw error;
      }
      if (journal) appendHookResult(agent.session, { turn, point: event, handlerId, output: run.output,
        stderrSummaryMaxChars: 1000, durationMs: run.durationMs });
      const result = interpret(event, run);
      if (hook.onFailure === 'block' && run.code !== 0) { result.block = true; result.reason ||= run.stderr || `${event} hook failed`; }
      if (run.output.updatedInput !== undefined) result.updatedInput = run.output.updatedInput;
      this.runs.unshift({ at: Date.now(), event, source: hook.source, command: trimTo(hook.command, 200), code: run.code,
        durationMs: run.durationMs, outcome: result.block || result.halt || result.permission === 'deny' ? 'blocked' : run.code === 0 ? 'ok' : 'error',
        detail: trimTo(result.reason || run.output.systemMessage || run.stderr.trim(), 600), session: input.session_id });
      this.runs.length = Math.min(this.runs.length, RUN_HISTORY);
      return { result, output: run.output };
    };
    const immediate = [];
    for (const hook of hooks) {
      if (!hook.async && !hook.asyncRewake) { immediate.push(invoke(hook)); continue; }
      const lifetime = this.lifetimes.get(agent);
      if (!lifetime) throw new Error('Async hook session lifecycle is unavailable');
      const task = invoke(hook, lifetime.signal).then(({ result }) => {
        if (lifetime.signal.aborted) return;
        const context = result.context || (hook.asyncRewake && result.block ? result.reason : '');
        if (context) {
          const message = contextMessage(event, context);
          if (hook.asyncRewake && result.block) agent.steer(message); else agent.inject(message);
        }
      }).catch(error => { if (!lifetime.signal.aborted) this.ctx.logger?.warn?.(`Async ${event} hook failed: ${errorText(error)}`); });
      let pending = this.agentRuns.get(agent);
      if (!pending) { pending = new Set(); this.agentRuns.set(agent, pending); }
      pending.add(task); this.running.add(task);
      void task.finally(() => { pending.delete(task); this.running.delete(task); });
    }
    const settled = await Promise.all(immediate);
    // Reuse native merge so deny/ask precedence and context ordering stay in
    // the same protocol vocabulary; the dispatcher retains event mapping.
    const merged = mergeHookOutputs(settled.map(item => item.output));
    if (merged.stop) agent.cancel({ kind: 'hook', reason: merged.stopReason ?? 'Hook requested termination' }, { keepInbox: true });
    return settled.map(item => item.result);
  }
  start() {
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      const hooks = await this.matching('PreToolUse', exec.name, exec.agent, exec.signal);
      if (!hooks.length) return next();
      const results = await this.run('PreToolUse', hooks, { tool_name: exec.name, tool_input: exec.arguments ?? null, tool_use_id: exec.callId }, { agent: exec.agent, signal: exec.signal });
      const deny = results.find(result => result.block || result.halt || result.permission === 'deny');
      if (deny) return { kind: 'deny', reason: deny.reason || 'Blocked by a PreToolUse hook.' };
      const ask = results.find(result => result.permission === 'ask');
      const updatedInput = results.filter(result => result.updatedInput !== undefined).at(-1)?.updatedInput;
      const context = results.map(result => result.context).filter(Boolean).join('\n\n');
      if (context) exec.agent.inject(contextMessage('PreToolUse', context));
      // An allow answer never bypasses the host's own approval policy.
      const downstream = await next();
      if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream;
      const decision = ask && downstream.kind !== 'ask' ? { ...downstream, kind: 'ask', ...(ask.reason ? { reason: ask.reason } : {}) } : downstream;
      return updatedInput === undefined || decision.updatedInput !== undefined ? decision : { ...decision, updatedInput };
    });
    this.ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (decision.kind === 'block') return decision;
      const hooks = await this.matching('PostToolUse', exec.name, exec.agent, exec.signal);
      if (!hooks.length) return decision;
      const response = result.isError ? { error: result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '' } : result.value ?? null;
      const results = await this.run('PostToolUse', hooks, { tool_name: exec.name, tool_input: exec.arguments ?? null, tool_use_id: exec.callId, tool_response: response }, { agent: exec.agent, signal: exec.signal });
      const notes = results.flatMap(item => [item.block && item.reason ? item.reason : '', item.context]).filter(Boolean);
      return notes.length ? { ...decision, additionalContexts: [...decision.additionalContexts ?? [], contextMessage('PostToolUse', notes.join('\n\n'))] } : decision;
    });
    this.ctx.on('agent/pre-step', async (payload, next) => {
      const proceed = async () => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      if (this.starts.has(payload.agent)) {
        const source = this.starts.get(payload.agent);
        const event = subagent(payload.agent) ? 'SubagentStart' : 'SessionStart';
        const hooks = await this.matching(event, subagent(payload.agent) ? 'general-purpose' : source, payload.agent, payload.signal);
        const results = hooks.length ? await this.run(event, hooks, { source }, { agent: payload.agent, signal: payload.signal }) : [];
        if (results.some(result => result.block || result.halt)) return { kind: 'reject' };
        const text = results.map(result => result.context).filter(Boolean).join('\n\n');
        if (text) decision.messages = [...decision.messages, contextMessage('SessionStart', text)];
        this.starts.delete(payload.agent);
      }
      const prompts = decision.messages.filter(message => message.source?.kind === 'user');
      if (!prompts.length) return decision;
      const hooks = await this.matching('UserPromptSubmit', '', payload.agent, payload.signal);
      if (!hooks.length) return decision;
      const results = await this.run('UserPromptSubmit', hooks, { prompt: prompts.map(textOf).join('\n\n') }, { agent: payload.agent, signal: payload.signal });
      if (results.some(result => result.block || result.halt)) return { kind: 'reject' };
      const context = results.map(result => result.context).filter(Boolean).join('\n\n');
      return context ? { ...decision, messages: [...decision.messages, contextMessage('UserPromptSubmit', context)] } : decision;
      };
      const access = this.ctx.get('platformAccess');
      const principal = payload.messages.find(message => message.source?.kind === 'user' && message.source.principal?.kind === 'platform-human')?.source.principal;
      // Native channel admission supplied this source; model text and hook
      // output cannot construct it. This also covers the first, unlogged batch.
      return access && principal
        ? access.runAsContext(access.requireSession(principal, payload.agent.id, 'write'), proceed)
        : proceed();
    });
    this.ctx.on('agent/created', async ({ agent, source }) => {
      this.starts.set(agent, source);
      this.lifetimes.set(agent, new AbortController());
      // Registered after preset setup: this cleanup finishes before older
      // provider effects are unwound, unlike the agent/disposed notification.
      agent.ctx.effect(() => () => this.end(agent));
      return undefined;
    });
    this.ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      const event = subagent(agent) ? 'SubagentStop' : 'Stop';
      const hooks = await this.matching(event, subagent(agent) ? 'general-purpose' : '', agent, signal);
      if (!hooks.length) return;
      const state = this.stops.get(agent), active = state?.turn === turn;
      const results = await this.run(event, hooks, { stop_hook_active: active }, { agent, signal });
      const objection = results.find(result => (result.block || result.context) && !result.halt);
      if (objection && !objection.reason) objection.reason = objection.context;
      if (!objection) { this.stops.delete(agent); return; }
      this.stops.set(agent, { turn, count: (active ? state.count : 0) + 1 });
      agent.steer(createUserMessage({ source: hookSource('Stop'), content: [{ type: 'text', text: objection.reason || 'A Stop hook asked you to continue before finishing.' }] }));
    });
  }
  async end(agent) {
    try {
      this.lifetimes.get(agent)?.abort(new Error('Session is ending'));
      await Promise.allSettled([...(this.agentRuns.get(agent) ?? [])]);
      if (!this.contexts.has(agent)) return;
      const scoped = [...(this.skills.get(agent)?.values() ?? [])].map(skill => ({ file: skill.source, pluginRoot: skill.pluginRoot, document: { hooks: skill.hooks } }));
      const hooks = selectedHooks([...(this.documents.get(agent) ?? []), ...scoped], 'SessionEnd', '', matches);
      if (hooks.length) await this.run('SessionEnd', hooks, { reason: 'other' }, { agent });
    } catch (error) { this.ctx.logger?.warn?.(`SessionEnd hook was not completed: ${errorText(error)}`); }
    finally { this.skills.delete(agent); this.contexts.delete(agent); this.documents.delete(agent); this.projections.delete(agent); this.lifetimes.delete(agent); this.agentRuns.delete(agent); this.once.delete(agent); }
  }
  // --- Management -----------------------------------------------------------
  async list() {
    const { document, error } = await this.load();
    const items = [];
    for (const event of Object.keys(document.hooks)) {
      (Array.isArray(document.hooks[event]) ? document.hooks[event] : []).forEach((group, groupIndex) => {
        (Array.isArray(group?.hooks) ? group.hooks : []).forEach((hook, hookIndex) => {
          if (hook?.type !== 'command') return;
          items.push({ id: `${event}/${groupIndex}/${hookIndex}`, event, supported: EVENTS.includes(event), matcher: group.matcher ?? '',
            command: String(hook.command ?? ''), timeout: valid(hook.timeout) ? hook.timeout : null, enabled: hook.enabled !== false });
        });
      });
    }
    return { file: tilde(this.file), error, enabled: document.disableAllHooks !== true, events: EVENTS, matcherEvents: MATCHER_EVENTS, hooks: items, runs: this.runs,
      sessions: (this.ctx.get('agents')?.list() ?? []).map(agent => ({ id: agent.id, label: `${agent.session.header.cwd ?? ''} · ${agent.id}` })) };
  }
  edit(change) {
    this.controller.signal.throwIfAborted();
    const task = this.queue.then(() => this.write(change));
    this.queue = task.catch(() => {});
    return task;
  }
  async write(change) {
    // The file is authoritative. A cached read is only for event dispatch/UI.
    const { document: current, error } = await this.load({ force: true });
    if (error) fail('hooks-file-invalid', 'hooks.json cannot be parsed; fix or remove it first', { file: this.file });
    const document = structuredClone(current);
    change(document);
    for (const event of Object.keys(document.hooks)) {
      const groups = (document.hooks[event] ?? []).filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
      if (groups.length) document.hooks[event] = groups; else delete document.hooks[event];
    }
    await writeAtomic(this.file, JSON.stringify(document, null, 2) + '\n');
    this.cache.mtime = undefined;
  }
  static locate(document, id, expected) {
    const [event, group, hook] = String(id).split('/');
    const entry = document.hooks[event]?.[Number(group)]?.hooks?.[Number(hook)];
    if (!entry || (expected !== undefined && entry.command !== expected)) fail('hook-changed', 'hooks.json changed meanwhile; refresh and try again', {}, 409);
    return { event, group: Number(group), hook: Number(hook), entry };
  }
  static validate({ event, matcher, command, timeout }) {
    if (!EVENTS.includes(event)) fail('invalid-hook-event', 'Choose a supported event');
    if (typeof command !== 'string' || !command.trim()) fail('hook-command-required', 'A command is required');
    if (timeout !== undefined && timeout !== null && !valid(timeout)) fail('invalid-hook-timeout', 'Timeout must be between 1 and 600 seconds');
    if (matcher && MATCHER_EVENTS.includes(event)) try { new RegExp(matcher); } catch { fail('invalid-hook-matcher', 'The matcher is not a valid regular expression'); }
  }
  save({ id, expected, event, matcher = '', command, timeout, enabled = true }) {
    Hooks.validate({ event, matcher, command, timeout });
    const key = MATCHER_EVENTS.includes(event) ? matcher.trim() : '';
    return this.edit(document => {
      let hook = { type: 'command', command: command.trim() };
      if (id !== undefined) {
        const found = Hooks.locate(document, id, expected);
        hook = { ...found.entry, ...hook };
        document.hooks[found.event][found.group].hooks.splice(found.hook, 1);
      }
      if (timeout) hook.timeout = timeout; else delete hook.timeout;
      if (enabled === false) hook.enabled = false; else delete hook.enabled;
      const groups = document.hooks[event] ??= [];
      const group = groups.find(item => (item.matcher ?? '') === key && Array.isArray(item.hooks));
      if (group) group.hooks.push(hook); else groups.push({ ...key ? { matcher: key } : {}, hooks: [hook] });
    });
  }
  remove(id, expected) { return this.edit(document => { const found = Hooks.locate(document, id, expected); document.hooks[found.event][found.group].hooks.splice(found.hook, 1); }); }
  setEnabled(id, expected, enabled) {
    return this.edit(document => { const { entry } = Hooks.locate(document, id, expected); if (enabled) delete entry.enabled; else entry.enabled = false; });
  }
  setAll(enabled) { return this.edit(document => { if (enabled) delete document.disableAllHooks; else document.disableAllHooks = true; }); }
  /** Try a command with a representative input; nothing reaches a session. */
  async test({ event, command, timeout, sessionId }, signal) {
    Hooks.validate({ event, command, timeout });
    const agent = this.ctx.get('agents')?.get(sessionId);
    if (!agent) throw new Error('Choose an actual session for the hook try-run');
    const loaded = await hookSources(this.ctx, agent, signal, this.file);
    this.contexts.set(agent, loaded.context);
    const projection = await transcript(this.ctx, agent, signal);
    const input = { session_id: agent.session.id, cwd: loaded.context.cwd, hook_event_name: event,
      agent_type: subagent(agent) ? 'general-purpose' : 'main', ...projection,
      ...(event === 'SessionStart' ? { source: 'startup' } : event === 'Stop' ? { stop_hook_active: false }
        : event === 'UserPromptSubmit' ? { prompt: 'Hook try-run' } : { tool_name: 'Read', tool_input: {}, tool_use_id: 'hook-try-run' }) };
    // Try-run is outside the model turn: it never answers an approval, injects
    // model work, or manufactures turn-enclosed hook journal events.
    const run = await this.execute(command, input, { agent, event, hook: { type: 'command', command, timeout }, signal, allowApproval: false });
    return { ...run, stdout: trimTo(run.stdout, 4000), stderr: trimTo(run.stderr, 4000), result: interpret(event, run) };
  }
}
