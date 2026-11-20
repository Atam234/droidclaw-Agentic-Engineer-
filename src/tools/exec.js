'use strict';
const { exec } = require('child_process');
const registry = require('./registry');

// Long enough for package installs (pkg install python takes a few minutes on a phone).
const EXEC_TIMEOUT_MS = 5 * 60 * 1000;

// Models don't always format arguments perfectly — accept the common variants.
function pickCommand(args) {
  if (typeof args === 'string') return args.trim();
  if (!args || typeof args !== 'object') return '';
  const v = args.command ?? args.cmd ?? args.shell ?? args.script ?? args.code ?? args.input;
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.join(' ').trim();
  if (typeof args.raw === 'string') {
    const raw = args.raw.trim();
    // {"command": "…"} with broken JSON (e.g. unescaped quotes) → grab the value
    const m = raw.match(/"(?:command|cmd)"\s*:\s*"([\s\S]*)"\s*}?\s*$/);
    return (m ? m[1].replace(/\\"/g, '"') : raw.replace(/^[{\s]+|[}\s]+$/g, '')).trim();
  }
  return '';
}

registry.register('exec', (args = {}) => new Promise((resolve, reject) => {
  const command = pickCommand(args);
  if (!command) return reject(new Error('no command provided — use <tool:exec>{"command": "..."}</tool>'));
  exec(command, {
    encoding:  'utf8',
    timeout:   EXEC_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    // never wait for keyboard input — there is nobody to type it
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  }, (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr ? '\n' + stderr : ''}`.trim();
    // installs print a lot; the end of the output is what matters
    const tail = out.length > 1500 ? '…' + out.slice(-1500) : out;
    if (err) {
      const why = err.killed ? `timed out after ${EXEC_TIMEOUT_MS / 1000}s` : `exit code ${err.code}`;
      return resolve(`error (${why}): ${tail || err.message.split('\n')[0]}`);
    }
    resolve(tail || '(done, no output)');
  });
}), 'run a shell command in Termux and get its output (installs, files, termux-api commands, anything)');
