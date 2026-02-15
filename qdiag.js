const { spawn } = require('node:child_process');
const path = require('node:path');
const socketClientBundle = require('./node_modules/socket.io/client-dist/socket.io.js');
const ioClient = typeof socketClientBundle === 'function' ? socketClientBundle : socketClientBundle.io;

(async () => {
  const port = 40000 + Math.floor(Math.random() * 1000);
  const proc = spawn('node', [path.join(__dirname, 'dist/server/server/index.js')], {
    env: { ...process.env, PORT: String(port), MATCH_TIMEOUT_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const waitFor = (pattern) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting ' + pattern));
    }, 5000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes(pattern)) {
        clearTimeout(timeout);
        cleanup();
        resolve(text);
      }
    };
    const cleanup = () => {
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
      clearTimeout(timeout);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });

  await waitFor(`Server listening on http://localhost:${port}`);

  const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  socket.on('connect', () => console.log('connected', socket.id));
  socket.on('connect_error', (err) => console.log('connect_error', err?.message));
  socket.on('queue:queued', (p) => console.log('queued', p));
  socket.on('queue:matched', (p) => console.log('matched', p));
  socket.on('game:state', (p) => console.log('state', p.roomId, p.phase));
  socket.on('game:error', (p) => console.log('error', p));

  setTimeout(() => {
    console.log('emitting search:join');
    socket.emit('search:join', { nickname: 'Solo' });
  }, 100);

  setTimeout(() => {
    console.log('closing');
    socket.disconnect();
    proc.kill();
  }, 8000);
})();
