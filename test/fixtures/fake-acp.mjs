// Harmless ACP stub for lifecycle tests. It never touches the network or the real Qoder CLI.
import {appendFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';

// Even a failed test or killed test parent must not leave a permanent fixture.
setTimeout(()=>process.exit(0),60_000);

const ignoreTerm = process.env.FAKE_ACP_IGNORE_TERM === '1';
const pidFile = process.env.FAKE_ACP_PID_FILE;
if (pidFile) writeFileSync(pidFile, `${process.pid}\n`);
if (ignoreTerm) process.on('SIGTERM', () => { if (pidFile) appendFileSync(`${pidFile}.term`, 'term\n'); });
if (pidFile) {
  process.on('exit', (code, signal) => { try { appendFileSync(`${pidFile}.exit`, `${code} ${signal}\n`); } catch {} });
  process.on('uncaughtException', (error) => { try { appendFileSync(`${pidFile}.exit`, `uncaught ${error.message}\n`); } catch {} process.exit(7); });
  process.stdin.on('end', () => { try { appendFileSync(`${pidFile}.end`, 'stdin-end\n'); } catch {} });
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const promptIds = new Map();
createInterface({input: process.stdin}).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if(pidFile)appendFileSync(pidFile+'.events',String(message.method)+'\n');
  if (message.method === 'initialize') {
    if(process.env.FAKE_ACP_INVALID_RPC==='1'){process.stdout.write('not-json\n');return}
    send({jsonrpc: '2.0', id: message.id, result: {protocolVersion: 1, agentCapabilities: {}}});
    return;
  }
  if (message.method === 'session/new') {
    send({jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'native-fixture',
      models: {availableModels: [{modelId: 'DeepSeek-Flash', name: 'DeepSeek-Flash'}], currentModelId: 'DeepSeek-Flash'},
    }});
    return;
  }
  if (message.method === 'session/set_mode' || message.method === 'session/set_model') {
    send({jsonrpc: '2.0', id: message.id, result: {}});
    return;
  }
  if (message.method === 'session/cancel') {
    for (const id of promptIds.values()) send({jsonrpc: '2.0', id, result: {stopReason: 'cancelled'}});
    promptIds.clear();
    return;
  }
  if (message.method === 'session/prompt') {
    // Hold the turn open until cancelled so a dead owner leaves a live, idle process behind.
    promptIds.set(message.id, message.id);
    return;
  }
  if (message.id !== undefined && !message.method) return;
  if (message.id !== undefined) send({jsonrpc: '2.0', id: message.id, result: {}});
});
// stdin EOF is deliberately ignored: the fixture keeps holding its pipes like an orphaned ACP.
setInterval(() => {}, 1 << 30);
