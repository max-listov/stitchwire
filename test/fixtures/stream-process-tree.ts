const child = Bun.spawn([
  process.execPath,
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000)",
]);

process.stdout.write(`${process.pid}:${child.pid}\n`);
setInterval(() => {}, 60_000);
