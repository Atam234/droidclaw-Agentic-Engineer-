'use strict';
const { exec } = require('child_process');
const registry = require('./registry');

// Long enough for package installs (pkg install python takes a few minutes on a phone).
const EXEC_TIMEOUT_MS = 5 * 60 * 1000;

registry.register('exec', ({ command } = {}) => new Promise((resolve, reject) => {
  if (!command) return reject(new Error('no command provided'));
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
