const { spawnSync } = require('child_process');
const cmd = [
  ' = ' + process.pid,
  'Get-CimInstance Win32_Process -Filter "Name = ''node.exe'' OR Name = ''electron.exe''" |',
  '  Where-Object { .ProcessId -ne  -and .CommandLine -and .CommandLine -match ''codemux'' } |',
  '  Select-Object -ExpandProperty ProcessId',
].join('\n');
const start = Date.now();
const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
console.log('time:', Date.now() - start, 'ms');
console.log('status:', r.status);
console.log('stdout:', r.stdout.trim());
