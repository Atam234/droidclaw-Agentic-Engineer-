'use strict';
// Kira mobile app — talks to `kira serve` running in Termux.

(() => {
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('kira.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('kira.' + k, v); } catch {} },
  };

  const IN_NATIVE = !!window.Capacitor || location.protocol === 'capacitor:' || location.protocol === 'file:';
  const DEFAULT_URL = IN_NATIVE ? 'http://127.0.0.1:7071' : location.origin;

  // token passed in link: http://127.0.0.1:7071/#token=XYZ
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('token')) {
    store.set('token', hash.get('token'));
    if (!IN_NATIVE) store.set('server', location.origin);
    history.replaceState(null, '', location.pathname);
  }

  let server = store.get('server', DEFAULT_URL).replace(/\/+$/, '');
  let token  = store.get('token', '');
  let controller = null;
  let online = false;

  // ── api ─────────────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch(server + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    if (!res.ok) {
      let msg = res.status + '';
      try { msg = (await res.json()).error || msg; } catch {}
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return res;
  }
  const getJSON  = async (p) => (await api(p)).json();
  const postJSON = async (p, body) => (await api(p, { method: 'POST', body: JSON.stringify(body || {}) })).json();

  // ── ui helpers ──────────────────────────────────────────────────────────────
  function toast(text) {
    const t = $('#toast'); t.textContent = text; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function setConn(state, text) {
    const el = $('#conn');
    el.classList.toggle('ok', state === 'ok');
    el.classList.toggle('bad', state === 'bad');
    $('#connText').textContent = text;
  }

  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // tiny markdown: ```code```, `code`, **bold**, links
  function render(text) {
    const parts = text.split(/```/);
    return parts.map((p, i) => {
      if (i % 2 === 1) return '<pre>' + escapeHTML(p.replace(/^[a-z0-9+-]*\n/i, '')) + '</pre>';
      return escapeHTML(p)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    }).join('');
  }

  const messages = $('#messages');
  function scrollDown() { messages.scrollTop = messages.scrollHeight; }
  function nearBottom() { return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120; }

  function addMsg(role, text) {
    $('#empty')?.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = render(text || '');
    messages.appendChild(el);
    scrollDown();
    return el;
  }

  function addTool(name, detail) {
    const el = document.createElement('div');
    el.className = 'tool';
    el.innerHTML = '<b>⚙ ' + escapeHTML(name) + '</b><span>' + escapeHTML(detail || '') + '</span>';
    messages.appendChild(el);
    scrollDown();
    return el;
  }

  function showTyping() {
    removeTyping();
    const el = document.createElement('div');
    el.className = 'typing'; el.id = 'typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    messages.appendChild(el); scrollDown();
  }
  function removeTyping() { $('#typing')?.remove(); }

  function setBusy(busy) {
    const b = $('#sendBtn');
    b.classList.toggle('stop', busy);
    b.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  }

  // ── chat ────────────────────────────────────────────────────────────────────
  async function send(text) {
    text = text.trim();
    if (!text || controller) return;
    if (!token) { toast('set your app token in settings'); switchView('settings'); return; }

    addMsg('user', text);
    showTyping();
    setBusy(true);
    controller = new AbortController();

    let bubble = null, full = '', toolEl = null, gotError = false;
    const ensureBubble = () => {
      if (!bubble) { removeTyping(); bubble = addMsg('kira', ''); bubble.classList.add('streaming'); full = ''; }
      return bubble;
    };

    try {
      const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text }), signal: controller.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          const stick = nearBottom();
          switch (ev.type) {
            case 'token':
              ensureBubble(); full += ev.text; bubble.innerHTML = render(full);
              break;
            case 'tool_start':
              if (bubble) { bubble.classList.remove('streaming'); if (!full.trim()) bubble.remove(); bubble = null; }
              removeTyping();
              toolEl = addTool(ev.name, 'running…');
              showTyping();
              break;
            case 'tool':
              if (toolEl) toolEl.querySelector('span').textContent = ev.result;
              else addTool(ev.name, ev.result);
              toolEl = null;
              break;
            case 'done':
              removeTyping();
              if (!full.trim() && ev.reply && ev.reply.trim()) { ensureBubble(); full = ev.reply; bubble.innerHTML = render(full); }
              else if (bubble && !full.trim()) bubble.remove();
              else if (!bubble && !ev.aborted && !gotError) addMsg('error', 'no reply — try again?');
              break;
            case 'error':
              removeTyping(); addMsg('error', ev.error); gotError = true;
              break;
          }
          if (stick) scrollDown();
        }
      }
    } catch (e) {
      removeTyping();
      if (e.name === 'AbortError') { /* user stopped */ }
      else if (e.status === 401) { addMsg('error', 'wrong app token — check settings'); }
      else if (e.status === 412) { addMsg('error', e.message); switchView('settings'); }
      else if (e.status) addMsg('error', e.message);
      else addMsg('error', "can't reach kira. is `kira serve` running in Termux?");
    } finally {
      bubble?.classList.remove('streaming');
      removeTyping();
      controller = null;
      setBusy(false);
    }
  }

  async function stop() {
    if (!controller) return;
    try { await postJSON('/api/abort'); } catch {}
    controller.abort();
  }

  const input = $('#input');
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    // Enter sends on desktop keyboards; on phones the keyboard's enter adds a newline unless enterkeyhint=send
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (controller) return stop();
    const v = input.value; input.value = ''; autosize(); send(v);
  });
  $$('.chip').forEach((c) => c.addEventListener('click', () => send(c.textContent)));

  $('#clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear this conversation? Kira keeps her long-term memory.')) return;
    try { await postJSON('/api/clear'); } catch {}
    messages.innerHTML = '';
    toast('conversation cleared');
  });

  // ── views ───────────────────────────────────────────────────────────────────
  function switchView(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    if (name === 'mind') loadMind();
    if (name === 'settings') loadSettings();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  // ── mind ────────────────────────────────────────────────────────────────────
  function fillList(sel, items) {
    const ul = $(sel); ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li class="none">nothing yet</li>'; return; }
    for (const it of items) { const li = document.createElement('li'); li.textContent = it.value; ul.appendChild(li); }
  }
  async function loadMind() {
    try {
      const [t, s] = await Promise.all([getJSON('/api/thoughts'), getJSON('/api/status')]);
      $('#mood').textContent = t.mood || 'neutral';
      fillList('#thoughts', t.thoughts || []);
      fillList('#observations', t.observations || []);
      fillList('#uncertainties', t.uncertainties || []);
      const m = s.mind || {};
      $('#stats').innerHTML = [
        [m.memories ?? 0, 'memories'], [m.beliefs ?? 0, 'beliefs about you'], [m.conversations ?? 0, 'messages'],
      ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
    } catch (e) { toast(e.status === 401 ? 'wrong app token' : "can't reach kira"); }
  }
  $('#refreshMind').addEventListener('click', loadMind);

  // ── settings ────────────────────────────────────────────────────────────────
  async function loadSettings() {
    $('#serverUrl').value = server;
    $('#token').value = token;
    try {
      const s = await getJSON('/api/status');
      $('#cfgName').value = s.user || '';
      $('#cfgBaseUrl').value = s.baseUrl || '';
      $('#cfgModel').value = s.model || '';
      $('#cfgStatus').textContent = s.hasKey ? 'API key is set.' : 'No API key yet — Kira can\'t answer until you add one.';
    } catch { $('#cfgStatus').textContent = 'connect first to edit these.'; }
  }

  $('#connForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    server = $('#serverUrl').value.trim().replace(/\/+$/, '');
    token  = $('#token').value.trim();
    store.set('server', server); store.set('token', token);
    await ping();
    if (online) { toast('connected'); loadSettings(); }
  });

  $('#modelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await postJSON('/api/config', {
        name: $('#cfgName').value, baseUrl: $('#cfgBaseUrl').value,
        model: $('#cfgModel').value, apiKey: $('#cfgKey').value,
      });
      $('#cfgKey').value = '';
      toast('saved');
      loadSettings();
    } catch (err) { toast(err.message); }
  });

  // ── connection ──────────────────────────────────────────────────────────────
  async function ping() {
    try {
      if (!token) { online = false; setConn('bad', 'no token — open settings'); return; }
      const s = await getJSON('/api/status');
      online = true;
      setConn('ok', s.busy ? 'thinking…' : (s.hasKey ? 'online' : 'online · no API key'));
    } catch (e) {
      online = false;
      setConn('bad', e.status === 401 ? 'wrong token' : 'offline — run kira serve');
    }
  }

  async function loadHistory() {
    try {
      const { messages: hist } = await getJSON('/api/history');
      if (!hist || !hist.length) return;
      for (const m of hist.slice(-30)) addMsg(m.role === 'user' ? 'user' : 'kira', m.content);
    } catch {}
  }

  (async () => {
    await ping();
    if (online) loadHistory();
    else if (!token) switchView('settings');
    setInterval(() => { if (!controller) ping(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
  })();

  if ('serviceWorker' in navigator && !IN_NATIVE && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
