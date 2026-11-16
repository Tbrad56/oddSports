const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');

function fakeFetch() {
  const fn = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
  fn.calls = [];
  return fn;
}

function authApp(){
  return createApp({ apiKey: 'k', fetchFn: fakeFetch(), enableAuth: true, sessionSecret: 'test-secret' });
}

test('enableAuth requires a sessionSecret', () => {
  assert.throws(() => createApp({ apiKey: 'k', enableAuth: true }));
});

test('auth disabled by default: routes work with no session at all', async () => {
  const app = createApp({ apiKey: 'k', fetchFn: fakeFetch() });
  const res = await request(app).get('/api/record');
  assert.equal(res.status, 200);
});

test('status reports unconfigured before setup', async () => {
  const app = authApp();
  const res = await request(app).get('/api/auth/status');
  assert.deepEqual(res.body, { configured: false, username: null, webauthnEnabled: false, authenticated: false });
});

test('unauthenticated: API 401s, HTML page navigation gets the lock screen', async () => {
  const app = authApp();
  const apiRes = await request(app).get('/api/record');
  assert.equal(apiRes.status, 401);

  const pageRes = await request(app).get('/board.html');
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /LineWatch — Locked/);
});

test('/lock.html and /api/auth/* are always reachable unauthenticated', async () => {
  const app = authApp();
  assert.equal((await request(app).get('/lock.html')).status, 200);
  assert.equal((await request(app).get('/api/auth/status')).status, 200);
});

test('setup validates username and password', async () => {
  const app = authApp();
  const noUser = await request(app).post('/api/auth/setup').send({ username: '', password: 'longenough1' });
  assert.equal(noUser.status, 400);
  const shortPw = await request(app).post('/api/auth/setup').send({ username: 'me', password: 'short' });
  assert.equal(shortPw.status, 400);
});

test('setup succeeds once, logs the caller in, and cannot be repeated', async () => {
  const agent = request.agent(authApp());
  const setup = await agent.post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  assert.equal(setup.status, 200);

  // The setup call itself already established a session
  const record = await agent.get('/api/record');
  assert.equal(record.status, 200);

  const again = await agent.post('/api/auth/setup').send({ username: 'someoneelse', password: 'correcthorsebattery' });
  assert.equal(again.status, 409);
});

test('password hash is never stored or returned in plaintext', async () => {
  const agent = request.agent(authApp());
  await agent.post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  const status = await agent.get('/api/auth/status');
  assert.ok(!JSON.stringify(status.body).includes('correcthorsebattery'));
});

test('wrong password rejected, correct password logs in, logout invalidates the session', async () => {
  const app = authApp();
  const setupAgent = request.agent(app);
  await setupAgent.post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  await setupAgent.post('/api/auth/logout');
  const afterLogout = await setupAgent.get('/api/record');
  assert.equal(afterLogout.status, 401);

  const wrong = await request(app).post('/api/auth/login').send({ username: 'damion', password: 'nope' });
  assert.equal(wrong.status, 401);

  const loginAgent = request.agent(app);
  const right = await loginAgent.post('/api/auth/login').send({ username: 'damion', password: 'correcthorsebattery' });
  assert.equal(right.status, 200);
  const record = await loginAgent.get('/api/record');
  assert.equal(record.status, 200);
});

test('login rate limit kicks in after repeated failures', async () => {
  const app = authApp();
  await request(app).post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  let lastStatus;
  for (let i = 0; i < 11; i++) {
    const res = await request(app).post('/api/auth/login').send({ username: 'damion', password: 'wrong' });
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429);
});

test('a tampered session cookie is rejected', async () => {
  const app = authApp();
  await request(app).post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  const res = await request(app).get('/api/record').set('Cookie', 'lw_session=bogus.tampered');
  assert.equal(res.status, 401);
});

test('webauthn registration requires an existing session', async () => {
  const app = authApp();
  await request(app).post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  const res = await request(app).post('/api/auth/webauthn/register-options');
  assert.equal(res.status, 401);
});

test('webauthn login-options 400s when no biometric credential is registered', async () => {
  const app = authApp();
  await request(app).post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  const res = await request(app).post('/api/auth/webauthn/login-options');
  assert.equal(res.status, 400);
});

test('webauthn register-options returns a well-formed challenge once logged in', async () => {
  const agent = request.agent(authApp());
  await agent.post('/api/auth/setup').send({ username: 'damion', password: 'correcthorsebattery' });
  const res = await agent.post('/api/auth/webauthn/register-options');
  assert.equal(res.status, 200);
  assert.ok(res.body.challenge);
  assert.equal(res.body.rp.name, 'LineWatch');
  assert.equal(res.body.user.name, 'damion');
});
