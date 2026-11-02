import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAcceptancePackage, startAcceptanceServer} from '../cli/lib/functional-acceptance/scripts/lib/serve.mjs';

const GENERATOR = 'codex-squad-functional-acceptance';
const HTML = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
</head><body><script type="application/json" id="acceptance-data" nonce="a1b2c3d4">{"report":{"id":"acceptance-report"}}</script></body></html>`;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function packageFixture({genuine = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'squad-acceptance-serve-'));
  const html = Buffer.from(HTML);
  const manifest = {
    generator: {name: GENERATOR, version: '0.12.0'},
    input: {file: 'acceptance.json', sha256: 'f'.repeat(64)},
    report: {id: 'acceptance-report', title: '本机验收报告'},
    output: [{path: 'index.html', sha256: genuine ? digest(html) : '0'.repeat(64)}],
  };
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'THIRD-PARTY-NOTICES.txt'), 'third party notices\n');
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'images', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

function call(origin, path, {method = 'GET', headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = httpRequest({host: url.hostname, port: url.port, path, method, headers}, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.end();
  });
}

test('acceptance serve exposes the generated report on loopback only', async (t) => {
  const root = await packageFixture();
  const server = await startAcceptanceServer({directory: root, port: 0});
  t.after(async () => {
    await server.close();
    await rm(root, {recursive: true, force: true});
  });

  assert.equal(server.host, '127.0.0.1');
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(server.inputSha256, 'f'.repeat(64));

  const page = await call(server.url, '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.body.toString('utf8'), HTML);

  const image = await call(server.url, '/images/shot.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');

  const manifest = await call(server.url, '/manifest.json');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers['content-type'], 'application/json; charset=utf-8');

  const head = await call(server.url, '/', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('acceptance serve rejects traversal, symlink escapes, foreign hosts and writes', async (t) => {
  const root = await packageFixture();
  const outside = await mkdtemp(join(tmpdir(), 'squad-acceptance-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
  const server = await startAcceptanceServer({directory: root, port: 0});
  t.after(async () => {
    await server.close();
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  });

  for (const path of ['/../package.json', '/%2e%2e/package.json', '/images/../../package.json', '/linked.txt', '/missing.html']) {
    const response = await call(server.url, path);
    assert.equal(response.status, 404, path);
  }

  const host = `127.0.0.1:${server.port}`;
  assert.equal((await call(server.url, '/', {headers: {host: 'evil.example'}})).status, 403);
  assert.equal((await call(server.url, '/', {headers: {host: host}})).status, 200);
  assert.equal((await call(server.url, '/', {headers: {host: `localhost:${server.port}`}})).status, 200);

  const post = await call(server.url, '/', {method: 'POST'});
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');

  const loaded = loadAcceptancePackage(root);
  assert.equal(loaded.root, realpathSync(root));
  assert.equal(loaded.manifest.report.id, 'acceptance-report');
});

test('acceptance serve refuses tampered or foreign packages', async (t) => {
  const tampered = await packageFixture({genuine: false});
  const foreign = await (async () => {
    const root = await mkdtemp(join(tmpdir(), 'squad-acceptance-foreign-'));
    await writeFile(join(root, 'index.html'), HTML);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({generator: {name: 'other-tool'}}));
    return root;
  })();
  t.after(async () => {
    await rm(tampered, {recursive: true, force: true});
    await rm(foreign, {recursive: true, force: true});
  });

  assert.throws(() => loadAcceptancePackage(tampered), (error) => error.code === 'E_PACKAGE_TAMPERED');
  assert.throws(() => loadAcceptancePackage(foreign), (error) => error.code === 'E_PACKAGE_INVALID');
  await assert.rejects(startAcceptanceServer({directory: tampered, port: 0}), (error) => error.code === 'E_PACKAGE_TAMPERED');
  await assert.rejects(
    startAcceptanceServer({directory: tampered, port: 0, host: '0.0.0.0'}),
    (error) => error.code === 'E_SERVE_HOST',
  );
});
