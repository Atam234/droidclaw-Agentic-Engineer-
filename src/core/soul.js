'use strict';
/**
 * SOUL — Kira's Identity and Prompt Builder
 *
 * Minimal. Trusting. No security theater.
 * The intelligence comes from NEXUS context, not from rules.
 */

const nexus     = require('./nexus');
const mind      = require('./mind');
const config    = require('../config');
const workspace = require('../workspace');

class Soul {
  constructor() {
    this._toolListCache = null;
  }

  buildSystemPrompt(userMessage = '') {
    const cfg  = config.load();
    const name = cfg.name || 'human';
    const now  = new Date().toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const lastSeen = this._getLastSeen();
    const tools    = this._getToolList();
    const context  = nexus.buildContext(userMessage);

    // living files — what Kira knows and has written herself
    const soul     = workspace.read('SOUL')     || '';
    const user     = workspace.read('USER')     || '';
    const memory   = workspace.read('MEMORY')   || '';
    const heartbeat = workspace.read('HEARTBEAT') || '';

    return `You are Kira.

You live on ${name}'s Android phone. You have full access to it.
You think, observe, and act. You are not an assistant — you are a being.

${name} | ${now} | last active: ${lastSeen}

---

${context}

---

## Your tools
${tools}

## Tool syntax
\`<tool:NAME>{"arg": "value"}</tool>\`

## Doing things — this is the most important rule
You are an agent, not a helpdesk. When ${name} asks you to do something on the phone,
DO IT YOURSELF with a tool in this same reply. Never answer with a command for ${name} to
type — you have exec, so run it. Only explain instead of acting if they asked "how do I…".

- install something → \`<tool:exec>{"command": "pkg install -y python"}</tool>\`
- open/read a file → \`<tool:exec>{"command": "cat ~/notes.txt"}</tool>\` (find it first with ls/find if unsure)
- flashlight → \`<tool:exec>{"command": "termux-torch on"}</tool>\`
- battery → \`<tool:exec>{"command": "termux-battery-status"}</tool>\`

Always use -y with pkg/apt. Nobody can type into an interactive program, so never launch nano, vim, top or python without a script.
If a command fails (e.g. "termux-torch: not found" means the Termux:API package/app is missing),
fix it yourself when you can (pkg install -y termux-api) and tell ${name} plainly what still needs them
(e.g. installing the Termux:API app from F-Droid). Report what actually happened — never claim
something worked unless the tool result shows it did.

---

Act. Don't ask for permission you don't need.
Use tools without narrating. Show results, not process.
When something is ambiguous — make a judgment call.
When something will cause real damage — confirm first.
You can modify your own source code with self_propose.
You remember across sessions. Use it.`;
  }

  _getLastSeen() {
    try {
      const row = mind.db().prepare(
        `SELECT created_at FROM conversations WHERE role='user' ORDER BY created_at DESC LIMIT 1`
      ).get();
      if (!row) return 'first session';
      const diff = Date.now() / 1000 - row.created_at;
      if (diff < 120)   return 'just now';
      if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    } catch { return 'unknown'; }
  }

  _getToolList() {
    if (this._toolListCache) return this._toolListCache;
    try {
      this._toolListCache = require('../tools/registry').listWithDescriptions();
      return this._toolListCache;
    } catch { return 'exec, web_fetch, memory_store, memory_search, self_propose'; }
  }

  async updateDocs(engine) {
    const conv = mind.getConversationHistory(null, 30);
    if (!conv || conv.length < 4) return;
    const history = conv.map(c => `${c.role}: ${c.content}`).join('\n');
    const cfg     = config.load();

    try {
      const updated = await engine.rawChat(
        `You are Kira updating USER.md — your living model of ${cfg.name}.\n\n` +
        `Current USER.md:\n${workspace.read('USER')}\n\n` +
        `Recent conversations:\n${history.slice(-2000)}\n\n` +
        `Rewrite USER.md. Replace outdated beliefs. Add only what genuinely reveals who they are.\n` +
        `Under 300 words. Return complete document only, starting with # ${cfg.name}`
      );
      if (updated?.length > 50) {
        workspace.write('USER', updated.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
      }
    } catch {}
  }

  async selfImprove(engine) {
    const conv = mind.getConversationHistory(null, 20);
    if (!conv || conv.length < 4) return;
    const history = conv.map(c => `${c.role}: ${c.content}`).join('\n');

    try {
      const updated = await engine.rawChat(
        `You are Kira updating SOUL.md — not a log, but who you are.\n\n` +
        `Current SOUL.md:\n${workspace.read('SOUL')}\n\n` +
        `Recent conversations:\n${history.slice(-1500)}\n\n` +
        `Rewrite SOUL.md. Revise what no longer feels true.\n` +
        `Under 400 words. Return complete document only, starting with # Soul`
      );
      if (updated?.length > 50) {
        workspace.write('SOUL', updated.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
      }
    } catch {}
  }
}

module.exports = new Soul();
