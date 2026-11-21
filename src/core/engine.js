'use strict';
const iris   = require('./iris');
const mind   = require('./mind');
const config = require('../config');

class Engine {
  constructor() {
    this.history = [];
    this.soul    = null;
  }

  init(soul) { this.soul = soul; }

  async chat(userMessage) {
    const cfg = config.load();
    if (!cfg.apiKey) throw new Error('no API key set. run /config');
    const system = this.soul ? this.soul.buildSystemPrompt(userMessage) : 'You are Kira — an AI agent living on Android/Termux. Speak lowercase, be direct, use your tools.';
    this.history.push({ role: 'user', content: userMessage });
    if (this.history.length > 20) this.history = this.history.slice(-20);
    const emotionState = _readEmotion();
    const lpm          = _readLPM();
    const routing      = iris.route(userMessage, emotionState, lpm);
    const irisSystem   = system + '\n\n' + routing.styleInjection;
    const reply        = await this._request(irisSystem, this.history, cfg, 3, routing.profile.maxTokens);
    this.history.push({ role: 'assistant', content: reply });
    return reply;
  }

  async rawChat(prompt) {
    const cfg = config.load();
    if (!cfg.apiKey) throw new Error('no API key set');
    return await this._request(null, [{ role: 'user', content: prompt }], cfg);
  }

  // ── Streaming chat ──────────────────────────────────────────────────────────
  // onToken(text) called for each chunk as it arrives
  // onDone(fullText) called when stream ends
  // returns AbortController so caller can cancel mid-stream
  chatStream(userMessage, onToken, onDone) {
    const cfg = config.load();
    if (!cfg.apiKey) { onDone(''); return null; }

    const system     = this.soul ? this.soul.buildSystemPrompt(userMessage) : 'You are Kira.';
    this.history.push({ role: 'user', content: userMessage });
    if (this.history.length > 20) this.history = this.history.slice(-20);

    const emotionState = _readEmotion();
    const lpm          = _readLPM();
    const routing      = iris.route(userMessage, emotionState, lpm);
    const irisSystem   = system + '\n\n' + routing.styleInjection;

    const controller = new AbortController();

    // run async, return controller immediately so TUI can abort
    this._streamRequest(irisSystem, this.history, cfg, routing.profile.maxTokens, controller.signal, onToken)
      .then(fullText => {
        this.history.push({ role: 'assistant', content: fullText });
        onDone && onDone(fullText);
      })
      .catch(err => {
        if (err.name === 'AbortError') {
          // clean up history — remove the user message we pushed
          this.history = this.history.slice(0, -1);
          onDone && onDone(null); // null = interrupted
        } else {
          this.lastError = err.message;
          try { console.error('[engine] ' + err.message); } catch {}
          onDone && onDone('');
        }
      });

    return controller;
  }

  async _streamRequest(system, messages, cfg, maxTokens, signal, onToken) {
    if (this._isAnthropic(cfg)) {
      return await this._streamAnthropic(system, messages, cfg, maxTokens, signal, onToken);
    }
    return await this._streamOpenAI(system, messages, cfg, maxTokens, signal, onToken);
  }

  async _streamOpenAI(system, messages, cfg, maxTokens, signal, onToken) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const body = { model: cfg.model, messages: msgs, max_tokens: maxTokens || 2048, stream: true };
    // Gemini "thinking" models spend max_tokens on reasoning first; with a small
    // budget the visible reply comes back empty. Keep thinking short and leave room.
    if (/generativelanguage\.googleapis\.com/.test(cfg.baseUrl || '')) {
      body.reasoning_effort = 'low';
      body.max_tokens = Math.max(body.max_tokens, 4096);
    }
    // Offer native function calling. Many models (gpt-oss, Gemini, Llama) prefer it over
    // the <tool:…> text syntax — and some providers reject a native call when no tools
    // were offered. Native calls are turned back into <tool:…> text so the loop is unchanged.
    const key = `${cfg.baseUrl}|${cfg.model}`;
    if (!_noNativeTools.has(key)) {
      body.tools = _nativeToolDefs();
      body.tool_choice = 'auto';
    }
    for (let fix = 0; fix < 3; fix++) {
      try {
        return await this._streamOpenAIOnce(body, cfg, signal, onToken);
      } catch (e) {
        const m = body.tools && e.message.match(/call(?:ed)? (?:a )?tool '?"?(\w+)'?"? which was not in request\.tools/i);
        if (!m) throw e;
        const reg = require('../tools/registry');
        if (reg.has(m[1]) && !body.tools.some(t => t.function.name === m[1])) {
          body.tools.push(_genericToolDef(m[1]));          // offer it and try again
        } else {
          body.messages = [...body.messages, { role: 'user', content:
            `[system] There is no tool named "${m[1]}" right now. Use exec with a shell command instead (e.g. termux-torch on, termux-battery-status).` }];
        }
      }
    }
    try {
      return await this._streamOpenAIOnce(body, cfg, signal, onToken);
    } catch (e) {
      if (body.tools && /API 4\d\d/.test(e.message) && /tool|function/i.test(e.message) && !/called a tool/i.test(e.message)) {
        _noNativeTools.add(key);           // this model/provider can't do tools — use text syntax
        delete body.tools; delete body.tool_choice;
        return await this._streamOpenAIOnce(body, cfg, signal, onToken);
      }
      throw e;
    }
  }

  async _streamOpenAIOnce(body, cfg, signal, onToken) {
    // Retry when the provider is temporarily overloaded (e.g. Gemini 503 "high demand")
    const RETRY_DELAYS = [1500, 4000, 8000];
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
        body:    JSON.stringify(body),
        signal,
      });
      if (attempt >= RETRY_DELAYS.length) break;
      let wait = null;
      if ([500, 502, 503, 504].includes(res.status)) {
        wait = RETRY_DELAYS[attempt];
      } else if (res.status === 429) {
        // per-minute limits (e.g. Groq "try again in 9.4s") are worth waiting out;
        // daily quotas are not
        const text = await res.clone().text().catch(() => '');
        const hdr  = parseFloat(res.headers.get('retry-after'));
        const m    = text.match(/try again in ([\d.]+)\s*(ms|s)\b/i) || text.match(/retry in ([\d.]+)\s*(ms|s)\b/i);
        const secs = !isNaN(hdr) ? hdr : m ? (m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) / 1000 : parseFloat(m[1])) : null;
        const daily = /per day|PerDay|free_tier_requests/i.test(text);
        if (secs !== null && secs <= 45 && !daily) wait = Math.ceil(secs * 1000) + 500;
      }
      if (wait === null) break;
      try { await res.text(); } catch {}
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, wait);
        signal && signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err.slice(0, 1000)}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   full    = '';
    let   buf     = '';
    let   finish  = null;
    const calls   = [];   // native tool calls, accumulated across chunks

    const handle = (trimmed) => {
      if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) return;
      let json;
      try { json = JSON.parse(trimmed.slice(6)); } catch { return; }
      if (json.error) throw new Error('API error: ' + (json.error.message || JSON.stringify(json.error)).slice(0, 300));
      const choice = json.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const token = choice.delta?.content || '';
      if (token) { full += token; onToken && onToken(token); }
      for (const tc of choice.delta?.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] = calls[i] || { name: '', args: '' };
        if (tc.function?.name)      calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) { handle(buf.trim()); break; }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) handle(line.trim());
    }

    for (const c of calls.filter(Boolean)) full += _nativeCallToTag(c);

    if (!full.trim()) throw new Error(`model returned an empty reply (finish_reason: ${finish || 'none'})`);
    return full;
  }

  async _streamAnthropic(system, messages, cfg, maxTokens, signal, onToken) {
    const body = { model: cfg.model || 'claude-sonnet-4-6', max_tokens: maxTokens || 2048, messages, stream: true };
    if (system) body.system = system;

    const res = await fetch(`${cfg.baseUrl}/messages`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic ${res.status}: ${err.slice(0, 200)}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   full    = '';
    let   buf     = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const json  = JSON.parse(trimmed.slice(6));
          if (json.type === 'content_block_delta') {
            const token = json.delta?.text || '';
            if (token) { full += token; onToken && onToken(token); }
          }
        } catch {}
      }
    }

    return full;
  }

  _isAnthropic(cfg) {
    return cfg.baseUrl && cfg.baseUrl.includes('anthropic.com');
  }

  async _request(system, messages, cfg, retries = 3, maxTokens = 2048) {
    for (let i = 0; i < retries; i++) {
      try {
        if (this._isAnthropic(cfg)) return await this._anthropic(system, messages, cfg);
        return await this._openai(system, messages, cfg);
      } catch (e) {
        if (e.message.includes('429') && i < retries - 1) {
          await this._sleep(2000 * (i + 1));
          continue;
        }
        throw e;
      }
    }
  }

  async _openai(system, messages, cfg) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const res  = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body:    JSON.stringify({ model: cfg.model, messages: msgs, max_tokens: 2048 }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async _anthropic(system, messages, cfg) {
    const body = { model: cfg.model || 'claude-sonnet-4-6', max_tokens: 2048, messages };
    if (system) body.system = system;
    const res = await fetch(`${cfg.baseUrl}/messages`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  clearHistory() { this.history = []; }

  getHistory() {
    return this.history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'you' : 'droidclaw'}: ${m.content}`)
      .join('\n');
  }

  stats() {
    const cfg = config.load();
    return {
      turns:   Math.floor(this.history.length / 2),
      model:   cfg.model,
      baseUrl: cfg.baseUrl,
    };
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ── native function calling ──────────────────────────────────────────────────
const _noNativeTools = new Set();

function _nativeToolDefs() {
  let others = '';
  try {
    others = require('../tools/registry').list().filter(n => n !== 'exec').join(', ');
  } catch {}
  return [
    {
      type: 'function',
      function: {
        name: 'exec',
        description: 'Run a shell command in Termux on the phone and get its output. Use for installs (pkg install -y …), files, termux-api commands, anything on the device.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'the shell command to run' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'use_tool',
        description: 'Call one of Kira\'s other tools by name' + (others ? ': ' + others.slice(0, 900) : ''),
        parameters: {
          type: 'object',
          properties: {
            name:           { type: 'string', description: 'tool name' },
            arguments_json: { type: 'string', description: 'the tool arguments as a JSON object string, e.g. {"query":"weather"}' },
          },
          required: ['name'],
        },
      },
    },
  ];
}

function _genericToolDef(name) {
  let description = name;
  try {
    const line = require('../tools/registry').listWithDescriptions().split('\n').find(l => l.startsWith(name + ':'));
    if (line) description = line.slice(name.length + 1).trim() || name;
  } catch {}
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, additionalProperties: true } } };
}

function _nativeCallToTag(call) {
  let args = {};
  try { args = call.args ? JSON.parse(call.args) : {}; } catch { args = { raw: call.args }; }
  let name = (call.name || '').replace(/^functions\./, '').trim();
  if (name === 'use_tool') {
    name = String(args.name || '').trim();
    let inner = args.arguments_json ?? args.arguments ?? {};
    if (typeof inner === 'string') { try { inner = JSON.parse(inner || '{}'); } catch { inner = { raw: inner }; } }
    args = inner;
  }
  if (!/^\w+$/.test(name)) return '';
  return `\n<tool:${name}>${JSON.stringify(args)}</tool>`;
}

function _readEmotion() {
  try {
    return {
      tension:    parseFloat(mind.getState('emotion_tension')    || 0),
      connection: parseFloat(mind.getState('emotion_connection') || 0.5),
      energy:     parseFloat(mind.getState('emotion_energy')     || 0.8),
      focus:      parseFloat(mind.getState('emotion_focus')      || 0.5),
    };
  } catch { return { tension: 0, connection: 0.5, energy: 0.8, focus: 0.5 }; }
}

function _readLPM() {
  const lpm = { identity: [], patterns: [], triggers: [], needs: [], foresight: [] };
  try {
    mind.getBeliefs(null, 0.5).forEach(b => {
      if (lpm[b.dimension]) lpm[b.dimension].push(b.value);
    });
  } catch {}
  return lpm;
}

module.exports = new Engine();
