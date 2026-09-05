const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('会话验证、越权保护和静态文件隔离', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-auth-'));
  for (const name of ['server.js', 'auth.js', 'index.html']) fs.copyFileSync(path.join(__dirname, name), path.join(dir, name));
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = require('node:crypto').randomBytes(24).toString('hex');
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: {
    ...process.env, NODE_PATH: path.join(__dirname, 'node_modules'), NODE_ENV: 'test',
    PORT: String(port), MYSQL_PORT: '1', REQUIRE_DATABASE: 'false', ADMIN_PASSWORD: password
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('启动超时')), 15000);
    child.stdout.on('data', data => { if (data.toString().includes('本地地址')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`启动失败 ${code}`)); });
  });
  const request = (url, body, cookie) => fetch(`http://127.0.0.1:${port}${url}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  for (const url of ['/api/admin/settings', '/api/admin/users', '/api/user?id=admin_owner', '/api/generate/status?id=fake']) {
    assert.equal((await request(url)).status, 401, url);
  }
  for (const url of ['/server.js', '/app_settings.json', '/users.json', '/.git/config', '/auth.js']) {
    assert.equal((await request(url)).status, 403, url);
  }
  assert.equal((await request('/api/admin/login', { password: 'wrong' })).status, 401);
  const login = await request('/api/admin/login', { password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const adminCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/admin/settings', null, adminCookie)).status, 200);
  assert.equal((await request('/api/admin/session', {}, adminCookie)).status, 200);
  const registered = await request('/api/login', { username: 'test-account', realName: '测试', password, isRegister: true, deviceFingerprint: 'test-device' });
  assert.equal(registered.status, 200);
  const userCookie = registered.headers.get('set-cookie').split(';')[0];
  const user = (await registered.json()).user;
  assert.equal((await request('/api/admin/settings', null, userCookie)).status, 403);
  const own = await request('/api/user?id=admin_owner', null, userCookie);
  assert.equal((await own.json()).user.id, user.id);
  const update = await request('/api/user/update', { userId: 'admin_owner', username: 'test-renamed', realName: '测试' }, userCookie);
  assert.equal((await update.json()).user.id, user.id);
  await request('/api/logout', {}, adminCookie);
  assert.equal((await request('/api/admin/settings', null, adminCookie)).status, 401);
});
