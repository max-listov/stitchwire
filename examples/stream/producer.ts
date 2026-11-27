// Operator-selected fixed executable. No caller script or arbitrary arguments are accepted.
if (process.argv.includes('--quiet')) await Bun.sleep(5000);
else process.stdout.write('synthetic line\n');
export {};
