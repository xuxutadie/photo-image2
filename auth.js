const crypto = require('crypto');

// 会话仅保存在服务端；重启后需重新登录，浏览器脚本无法读取会话凭证。
const sessions = new Map();
const attempts = new Map();
const ttl = 12 * 60 * 60 * 1000;

function token(req) {
  return /(?:^|;\s*)photo_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
}
function cookie(value, age) {
  return `photo_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function login(req, res, userId, admin = false) {
  sessions.delete(token(req));
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { userId, admin, expires: Date.now() + ttl });
  res.setHeader('Set-Cookie', cookie(id, ttl / 1000));
}
function logout(req, res) {
  sessions.delete(token(req));
  res.setHeader('Set-Cookie', cookie('', 0));
}
function session(req) {
  const id = token(req);
  const value = sessions.get(id);
  if (!value || value.expires <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return value;
}
function allowLogin(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0];
  const now = Date.now();
  let value = attempts.get(ip);
  if (!value || value.until <= now) value = { count: 0, until: now + 15 * 60 * 1000 };
  value.count++;
  attempts.set(ip, value);
  return value.count <= 20;
}
function checkPassword(input, expected) {
  if (!expected || typeof input !== 'string') return false;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(input), digest(expected));
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
}, 60000).unref();

module.exports = { login, logout, session, allowLogin, checkPassword };
