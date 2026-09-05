/**
 * 智影魔图 - MySQL 正式商用版后端
 * 使用方法:
 * 1. 启动 MySQL 服务
 * 2. 可通过环境变量配置连接信息
 * 3. 执行: npm install && node server.js
 * 4. 浏览器打开: http://localhost:8080
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const auth = require('./auth');

const PORT = parseInt(process.env.PORT || '8080', 10);
const LEGACY_USERS_FILE = path.join(__dirname, 'users.json');
const LEGACY_IP_FILE = path.join(__dirname, 'ip_records.json');
const JSON_SETTINGS_FILE = path.join(__dirname, 'app_settings.json');
const JSON_TEMPLATES_FILE = path.join(__dirname, 'user_templates.json');
const TEMPLATE_UPLOAD_DIR = path.join(__dirname, 'user_templates');
const FIXED_IMAGE_QUALITY = '1k';
const FREE_TRIAL_QUOTA = 10;
const MONTHLY_MEMBER_QUOTA = 200;
const MONTHLY_MEMBER_PRICE = 19.9;
const MEMBERSHIP_DURATION_DAYS = 30;
const LEGACY_POINTS_PER_GENERATION = 58;
const STARTER_POINTS = FREE_TRIAL_QUOTA;
const IP_REGISTER_LIMIT_PER_DAY = 5;
const DEVICE_FREE_CLAIM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_USER_ID = 'admin_owner';
const ADMIN_USERNAME = '平台管理员';
const BCRYPT_ROUNDS = 10;
const GENERATION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const UPSTREAM_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_APP_SETTINGS = {
  apiEndpoint: 'https://api.openai-hk.com/v1/images/generations',
  apiKey: '',
  model: 'gpt-image-2',
  apiEnabled: false,
};
const WX_APP_ID = process.env.WX_APP_ID || 'wxe63d466a644acc73';
const WX_APP_SECRET = process.env.WX_APP_SECRET || '';

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || process.env.MYSQL_USERNAME || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'cyber_forge',
  charset: 'utf8mb4',
};

let pool = null;
let useJsonStore = false;
let jsonUsers = {};
let jsonIpRegistrations = {};
let jsonAppSettings = {};
let jsonTemplates = [];
const generationJobs = new Map();

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[JSON] 读取 ${path.basename(filePath)} 失败:`, error.message);
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function toSafeInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampQuota(value, max = Number.MAX_SAFE_INTEGER) {
  return Math.max(0, Math.min(max, toSafeInt(value, 0)));
}

function legacyPointsToQuota(points) {
  const legacyPoints = toSafeInt(points, 0);
  if (legacyPoints <= 0) return 0;
  return Math.min(FREE_TRIAL_QUOTA, Math.ceil(legacyPoints / LEGACY_POINTS_PER_GENERATION));
}

function getQuotaPeriod() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function isActiveMonthlyMember(row) {
  const membershipType = row?.membership_type || row?.membershipType || 'free';
  const membershipExpiresAt = toSafeInt(row?.membership_expires_at || row?.membershipExpiresAt || 0, 0);
  return membershipType === 'monthly' && membershipExpiresAt > Date.now();
}

function getFreeQuotaRemaining(row) {
  if (Object.prototype.hasOwnProperty.call(row || {}, 'free_quota_remaining')) {
    return clampQuota(row.free_quota_remaining, MONTHLY_MEMBER_QUOTA);
  }
  if (Object.prototype.hasOwnProperty.call(row || {}, 'freeQuotaRemaining')) {
    return clampQuota(row.freeQuotaRemaining, MONTHLY_MEMBER_QUOTA);
  }
  return legacyPointsToQuota(row?.points);
}

function getMonthlyQuotaUsed(row) {
  return clampQuota(row?.monthly_quota_used || row?.monthlyQuotaUsed || 0, MONTHLY_MEMBER_QUOTA);
}

function buildQuotaSummary(row) {
  const isMember = isActiveMonthlyMember(row);
  const freeQuotaRemaining = getFreeQuotaRemaining(row);
  const monthlyQuotaUsed = getMonthlyQuotaUsed(row);
  const monthlyQuotaRemaining = isMember ? Math.max(0, MONTHLY_MEMBER_QUOTA - monthlyQuotaUsed) : 0;
  return {
    isMember,
    freeQuotaRemaining,
    monthlyQuotaUsed,
    monthlyQuotaLimit: MONTHLY_MEMBER_QUOTA,
    monthlyQuotaRemaining,
    quotaRemaining: isMember ? monthlyQuotaRemaining : freeQuotaRemaining,
    membershipPrice: MONTHLY_MEMBER_PRICE,
  };
}

function hashDeviceFingerprint(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function loadJsonStore() {
  const rawUsers = readJsonFile(LEGACY_USERS_FILE, {});
  const normalizedUsers = {};

  for (const user of Object.values(rawUsers)) {
    if (!user || !user.id || !user.username) continue;

    let passwordHash = user.password_hash || null;
    if (!passwordHash && user.password) {
      passwordHash = await bcrypt.hash(String(user.password), BCRYPT_ROUNDS);
    }

    const registeredAt = parseInt(user.registered_at || user.registeredAt || Date.now(), 10);
    normalizedUsers[user.id] = {
      id: user.id,
      username: user.username,
      real_name: user.real_name || user.realName || null,
      password_hash: passwordHash,
      points: toSafeInt(user.points || 0, 10),
      free_quota_remaining: getFreeQuotaRemaining(user),
      monthly_quota_used: getMonthlyQuotaUsed(user),
      quota_period: user.quota_period || user.quotaPeriod || getQuotaPeriod(),
      device_fingerprint: user.device_fingerprint || user.deviceFingerprint || null,
      membership_type: user.membership_type || user.membershipType || 'free',
      membership_expires_at: toSafeInt(user.membership_expires_at || user.membershipExpiresAt || 0, 10),
      registered_at: registeredAt,
      register_ip: user.register_ip || user.registerIp || null,
      open_id: user.open_id || user.openId || null,
      created_at: parseInt(user.created_at || registeredAt, 10),
      updated_at: parseInt(user.updated_at || Date.now(), 10),
    };
  }

  jsonUsers = normalizedUsers;
  jsonIpRegistrations = readJsonFile(LEGACY_IP_FILE, {});
  jsonAppSettings = readJsonFile(JSON_SETTINGS_FILE, {});
  jsonTemplates = readJsonFile(JSON_TEMPLATES_FILE, []);
  if (!Array.isArray(jsonTemplates)) {
    jsonTemplates = [];
  }
}

function persistJsonUsers() {
  writeJsonFile(LEGACY_USERS_FILE, jsonUsers);
}

function persistJsonIpRegistrations() {
  writeJsonFile(LEGACY_IP_FILE, jsonIpRegistrations);
}

function persistJsonSettings() {
  writeJsonFile(JSON_SETTINGS_FILE, jsonAppSettings);
}

function persistJsonTemplates() {
  writeJsonFile(JSON_TEMPLATES_FILE, jsonTemplates);
}

async function initDatabase() {
  fs.mkdirSync(TEMPLATE_UPLOAD_DIR, { recursive: true });

  try {
    const bootstrap = await mysql.createConnection({
      host: MYSQL_CONFIG.host,
      port: MYSQL_CONFIG.port,
      user: MYSQL_CONFIG.user,
      password: MYSQL_CONFIG.password,
      charset: MYSQL_CONFIG.charset,
      multipleStatements: true,
    });

    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${MYSQL_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrap.end();

    pool = mysql.createPool({
      host: MYSQL_CONFIG.host,
      port: MYSQL_CONFIG.port,
      user: MYSQL_CONFIG.user,
      password: MYSQL_CONFIG.password,
      database: MYSQL_CONFIG.database,
      charset: MYSQL_CONFIG.charset,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        real_name VARCHAR(255) NULL,
        password_hash VARCHAR(255) NULL,
        points INT NOT NULL DEFAULT 0,
        free_quota_remaining INT NOT NULL DEFAULT 10,
        monthly_quota_used INT NOT NULL DEFAULT 0,
        quota_period VARCHAR(16) NULL,
        device_fingerprint VARCHAR(128) NULL,
        membership_type VARCHAR(32) NOT NULL DEFAULT 'free',
        membership_expires_at BIGINT NOT NULL DEFAULT 0,
        registered_at BIGINT NOT NULL,
        register_ip VARCHAR(64) NULL,
        open_id VARCHAR(255) NULL,
        parent_id VARCHAR(64) NULL,
        grand_parent_id VARCHAR(64) NULL,
        referral_count INT NOT NULL DEFAULT 0,
        commission_points INT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_users_registered_at (registered_at),
        INDEX idx_users_register_ip (register_ip),
        INDEX idx_users_device_fingerprint (device_fingerprint)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const userColumnMigrations = [
      `ALTER TABLE users ADD COLUMN free_quota_remaining INT NOT NULL DEFAULT 10`,
      `ALTER TABLE users ADD COLUMN monthly_quota_used INT NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN quota_period VARCHAR(16) NULL`,
      `ALTER TABLE users ADD COLUMN device_fingerprint VARCHAR(128) NULL`,
      `ALTER TABLE users ADD COLUMN membership_type VARCHAR(32) NOT NULL DEFAULT 'free'`,
      `ALTER TABLE users ADD COLUMN membership_expires_at BIGINT NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN parent_id VARCHAR(64) NULL`,
      `ALTER TABLE users ADD COLUMN grand_parent_id VARCHAR(64) NULL`,
      `ALTER TABLE users ADD COLUMN referral_count INT NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN commission_points INT NOT NULL DEFAULT 0`,
    ];

    for (const sql of userColumnMigrations) {
      try {
        await query(sql);
      } catch (error) {
        if (!String(error.message || '').includes('Duplicate column')) throw error;
      }
    }

    await query(`
      CREATE TABLE IF NOT EXISTS ip_registrations (
        ip VARCHAR(64) PRIMARY KEY,
        last_registered_at BIGINT NOT NULL,
        register_count INT NOT NULL DEFAULT 1,
        window_start_at BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const ipColumnMigrations = [
      `ALTER TABLE ip_registrations ADD COLUMN register_count INT NOT NULL DEFAULT 1`,
      `ALTER TABLE ip_registrations ADD COLUMN window_start_at BIGINT NOT NULL DEFAULT 0`,
    ];

    for (const sql of ipColumnMigrations) {
      try {
        await query(sql);
      } catch (error) {
        if (!String(error.message || '').includes('Duplicate column')) throw error;
      }
    }

    await query(`
      CREATE TABLE IF NOT EXISTS device_registrations (
        device_fingerprint VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        registered_at BIGINT NOT NULL,
        last_ip VARCHAR(64) NULL,
        INDEX idx_device_registrations_registered_at (registered_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS point_logs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id VARCHAR(64) NOT NULL,
        change_amount INT NOT NULL,
        balance_after INT NOT NULL,
        action VARCHAR(64) NOT NULL,
        note VARCHAR(255) NULL,
        created_at BIGINT NOT NULL,
        INDEX idx_point_logs_user_id (user_id),
        INDEX idx_point_logs_created_at (created_at),
        CONSTRAINT fk_point_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS generation_logs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id VARCHAR(64) NOT NULL,
        quota_type VARCHAR(32) NOT NULL,
        quality VARCHAR(16) NOT NULL,
        job_type VARCHAR(32) NOT NULL,
        note VARCHAR(255) NULL,
        created_at BIGINT NOT NULL,
        INDEX idx_generation_logs_user_id (user_id),
        INDEX idx_generation_logs_created_at (created_at),
        CONSTRAINT fk_generation_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(64) PRIMARY KEY,
        setting_value TEXT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS user_templates (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description VARCHAR(255) NULL,
        category VARCHAR(64) NOT NULL,
        prompt TEXT NULL,
        image_url TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_user_templates_category (category),
        INDEX idx_user_templates_user_id (user_id),
        INDEX idx_user_templates_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await ensureDefaultSettings();
    await migrateLegacyData();
  } catch (error) {
    if (process.env.REQUIRE_DATABASE === 'true') throw error;
    useJsonStore = true;
    pool = null;
    await loadJsonStore();
    await ensureDefaultSettings();
    console.warn(`[启动] MySQL 不可用，已切换到 JSON 本地模式: ${error.message}`);
  }
}

async function ensureDefaultSettings() {
  if (useJsonStore) {
    jsonAppSettings = {
      api_endpoint: jsonAppSettings.api_endpoint || DEFAULT_APP_SETTINGS.apiEndpoint,
      api_key: jsonAppSettings.api_key || DEFAULT_APP_SETTINGS.apiKey,
      model: jsonAppSettings.model || DEFAULT_APP_SETTINGS.model,
      api_enabled: Object.prototype.hasOwnProperty.call(jsonAppSettings, 'api_enabled')
        ? jsonAppSettings.api_enabled
        : (DEFAULT_APP_SETTINGS.apiEnabled ? '1' : '0'),
      timer_end: jsonAppSettings.timer_end || '',
    };
    persistJsonSettings();
    return;
  }

  const now = Date.now();
  const defaults = {
    api_endpoint: DEFAULT_APP_SETTINGS.apiEndpoint,
    api_key: DEFAULT_APP_SETTINGS.apiKey,
    model: DEFAULT_APP_SETTINGS.model,
    api_enabled: DEFAULT_APP_SETTINGS.apiEnabled ? '1' : '0',
    timer_end: '',
  };

  for (const [key, value] of Object.entries(defaults)) {
    await query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value, updated_at = updated_at`,
      [key, String(value ?? ''), now]
    );
  }
}

async function migrateLegacyData() {
  const row = await getOne('SELECT COUNT(*) AS count FROM users');
  if (row && row.count > 0) return;

  let legacyUsers = {};
  let legacyIpRecords = {};

  if (fs.existsSync(LEGACY_USERS_FILE)) {
    try {
      legacyUsers = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, 'utf8'));
    } catch (error) {
      console.error('读取旧 users.json 失败:', error.message);
    }
  }

  if (fs.existsSync(LEGACY_IP_FILE)) {
    try {
      legacyIpRecords = JSON.parse(fs.readFileSync(LEGACY_IP_FILE, 'utf8'));
    } catch (error) {
      console.error('读取旧 ip_records.json 失败:', error.message);
    }
  }

  for (const user of Object.values(legacyUsers)) {
    const passwordHash = user.password
      ? await bcrypt.hash(user.password, BCRYPT_ROUNDS)
      : null;
    const createdAt = parseInt(user.registeredAt || Date.now(), 10);

    await query(
      `INSERT INTO users
       (id, username, real_name, password_hash, points, free_quota_remaining, monthly_quota_used, quota_period, membership_type, membership_expires_at, registered_at, register_ip, open_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE username = VALUES(username)`,
      [
        user.id,
        user.username,
        user.realName || null,
        passwordHash,
        parseInt(user.points || 0, 10),
        getFreeQuotaRemaining(user),
        getMonthlyQuotaUsed(user),
        user.quota_period || user.quotaPeriod || getQuotaPeriod(),
        user.membershipType || user.membership_type || 'free',
        parseInt(user.membershipExpiresAt || user.membership_expires_at || 0, 10),
        createdAt,
        user.registerIp || null,
        user.openId || null,
        createdAt,
        Date.now(),
      ]
    );
  }

  for (const [ip, timestamp] of Object.entries(legacyIpRecords)) {
    const normalizedRecord = typeof timestamp === 'object' && timestamp !== null
      ? timestamp
      : { last_registered_at: timestamp };
    const lastRegisteredAt = parseInt(normalizedRecord.last_registered_at || normalizedRecord.lastRegisteredAt || timestamp || 0, 10);
    await query(
      `INSERT INTO ip_registrations (ip, last_registered_at, register_count, window_start_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_registered_at = VALUES(last_registered_at)`,
      [
        ip,
        lastRegisteredAt,
        toSafeInt(normalizedRecord.register_count || normalizedRecord.registerCount || 1, 1),
        toSafeInt(normalizedRecord.window_start_at || normalizedRecord.windowStartAt || lastRegisteredAt, lastRegisteredAt),
      ]
    );
  }

  console.log('[MySQL] 旧 JSON 数据已迁移到 MySQL');
}

function normalizeUser(row) {
  if (!row) return null;
  const membershipExpiresAt = toSafeInt(row.membership_expires_at || row.membershipExpiresAt || 0, 0);
  const membershipType = row.membership_type || row.membershipType || 'free';
  const quota = buildQuotaSummary(row);
  return {
    id: row.id,
    username: row.username,
    realName: row.real_name,
    // 保留 points 字段给旧前端兜底，新界面统一使用 quotaRemaining。
    points: quota.quotaRemaining,
    freeQuotaRemaining: quota.freeQuotaRemaining,
    monthlyQuotaUsed: quota.monthlyQuotaUsed,
    monthlyQuotaLimit: quota.monthlyQuotaLimit,
    monthlyQuotaRemaining: quota.monthlyQuotaRemaining,
    quotaRemaining: quota.quotaRemaining,
    membershipPrice: quota.membershipPrice,
    membershipType,
    membershipExpiresAt,
    isMember: quota.isMember,
    registeredAt: row.registered_at,
    registerIp: row.register_ip,
    openId: row.open_id,
  };
}

function normalizeTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id || row.userId,
    title: row.title,
    desc: row.description || row.desc || '',
    category: row.category,
    prompt: row.prompt || '',
    image: row.image_url || row.image || '',
    createdAt: row.created_at || row.createdAt,
  };
}

function sanitizeTemplateCategory(category) {
  const value = String(category || '').trim();
  const allowed = new Set([
    'poster',
    'ecommerce',
    'game',
    'brand',
    'profile',
    'student',
    'idphoto',
    'parent',
    'teacher',
    'ads',
    'interior',
    'renovation',
    'restoration',
    'knowledge',
    'media',
  ]);
  return allowed.has(value) ? value : '';
}

function saveTemplateImage(imageData) {
  if (!imageData) return '';

  const text = String(imageData);
  const match = text.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  const ext = match
    ? (match[1].toLowerCase().startsWith('jp') ? 'jpg' : match[1].toLowerCase())
    : 'png';
  const base64 = match ? match[2] : text;
  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
    const err = new Error('模板图片无效或超过 12MB');
    err.statusCode = 400;
    throw err;
  }

  fs.mkdirSync(TEMPLATE_UPLOAD_DIR, { recursive: true });
  const filename = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
  fs.writeFileSync(path.join(TEMPLATE_UPLOAD_DIR, filename), buffer);
  return `/user_templates/${filename}`;
}

async function listUserTemplates(category) {
  const normalizedCategory = sanitizeTemplateCategory(category);
  if (useJsonStore) {
    return jsonTemplates
      .filter((item) => !normalizedCategory || item.category === normalizedCategory)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .map(normalizeTemplate);
  }

  const rows = normalizedCategory
    ? await query('SELECT * FROM user_templates WHERE category = ? ORDER BY created_at DESC', [normalizedCategory])
    : await query('SELECT * FROM user_templates ORDER BY created_at DESC');
  return rows.map(normalizeTemplate);
}

async function createUserTemplate(data) {
  const userId = String(data.userId || '').trim();
  const user = userId ? await getUserById(userId) : null;
  if (!user) {
    const err = new Error('请先登录后再上传模板');
    err.statusCode = 401;
    throw err;
  }

  const category = sanitizeTemplateCategory(data.category);
  if (!category) {
    const err = new Error('上传模板必须选择分类');
    err.statusCode = 400;
    throw err;
  }

  const title = String(data.title || '').trim();
  if (!title) {
    const err = new Error('请填写模板名称');
    err.statusCode = 400;
    throw err;
  }

  const prompt = String(data.prompt || '').trim();
  const description = String(data.desc || data.description || '').trim();
  const imageUrl = String(data.imageUrl || '').trim() || saveTemplateImage(data.imageData);
  if (!imageUrl) {
    const err = new Error('请提供模板图片');
    err.statusCode = 400;
    throw err;
  }

  const now = Date.now();
  const template = {
    id: `tpl_${now}_${Math.random().toString(36).slice(2, 8)}`,
    user_id: userId,
    title,
    description,
    category,
    prompt,
    image_url: imageUrl,
    created_at: now,
    updated_at: now,
  };

  if (useJsonStore) {
    jsonTemplates.push(template);
    persistJsonTemplates();
    return normalizeTemplate(template);
  }

  await query(
    `INSERT INTO user_templates
     (id, user_id, title, description, category, prompt, image_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      template.id,
      template.user_id,
      template.title,
      template.description,
      template.category,
      template.prompt,
      template.image_url,
      template.created_at,
      template.updated_at,
    ]
  );
  return normalizeTemplate(template);
}

async function getAppSettings() {
  if (useJsonStore) {
    return {
      apiEndpoint: jsonAppSettings.api_endpoint || DEFAULT_APP_SETTINGS.apiEndpoint,
      apiKey: jsonAppSettings.api_key || DEFAULT_APP_SETTINGS.apiKey,
      model: jsonAppSettings.model || DEFAULT_APP_SETTINGS.model,
      apiEnabled: jsonAppSettings.api_enabled === '1',
    };
  }

  const rows = await query('SELECT setting_key, setting_value FROM app_settings');
  const map = {};
  for (const row of rows) {
    map[row.setting_key] = row.setting_value;
  }
  return {
    apiEndpoint: map.api_endpoint || DEFAULT_APP_SETTINGS.apiEndpoint,
    apiKey: map.api_key || DEFAULT_APP_SETTINGS.apiKey,
    model: map.model || DEFAULT_APP_SETTINGS.model,
    apiEnabled: map.api_enabled === '1',
  };
}

async function saveAppSettings(nextSettings) {
  if (useJsonStore) {
    jsonAppSettings.api_endpoint = nextSettings.apiEndpoint || DEFAULT_APP_SETTINGS.apiEndpoint;
    jsonAppSettings.api_key = nextSettings.apiKey || '';
    jsonAppSettings.model = nextSettings.model || DEFAULT_APP_SETTINGS.model;
    jsonAppSettings.api_enabled = nextSettings.apiEnabled ? '1' : '0';
    // 清除历史定时值，后台不再提供定时关闭功能。
    jsonAppSettings.timer_end = '';
    persistJsonSettings();
    return getAppSettings();
  }

  const now = Date.now();
  const entries = {
    api_endpoint: nextSettings.apiEndpoint || DEFAULT_APP_SETTINGS.apiEndpoint,
    api_key: nextSettings.apiKey || '',
    model: nextSettings.model || DEFAULT_APP_SETTINGS.model,
    api_enabled: nextSettings.apiEnabled ? '1' : '0',
    timer_end: '',
  };

  for (const [key, value] of Object.entries(entries)) {
    await query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
      [key, String(value), now]
    );
  }

  return getAppSettings();
}

async function getUserById(userId) {
  if (useJsonStore) {
    return jsonUsers[userId] || null;
  }
  return getOne('SELECT * FROM users WHERE id = ?', [userId]);
}

async function getUserByUsername(username) {
  if (useJsonStore) {
    return Object.values(jsonUsers).find((user) => user.username === username) || null;
  }
  return getOne('SELECT * FROM users WHERE username = ?', [username]);
}

async function getUserByOpenId(openId) {
  if (!openId) return null;
  if (useJsonStore) {
    return Object.values(jsonUsers).find((user) => user.open_id === openId || user.openId === openId) || null;
  }
  return getOne('SELECT * FROM users WHERE open_id = ?', [openId]);
}

async function ensureAdminUser() {
  const now = Date.now();
  const expiresAt = now + MEMBERSHIP_DURATION_DAYS * 24 * 60 * 60 * 1000;

  if (useJsonStore) {
    const existing = jsonUsers[ADMIN_USER_ID];
    jsonUsers[ADMIN_USER_ID] = {
      ...(existing || {}),
      id: ADMIN_USER_ID,
      username: ADMIN_USERNAME,
      real_name: ADMIN_USERNAME,
      password_hash: null,
      points: FREE_TRIAL_QUOTA,
      free_quota_remaining: FREE_TRIAL_QUOTA,
      monthly_quota_used: 0,
      quota_period: getQuotaPeriod(),
      membership_type: 'monthly',
      membership_expires_at: expiresAt,
      registered_at: existing?.registered_at || now,
      register_ip: existing?.register_ip || 'admin',
      open_id: null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    persistJsonUsers();
    return jsonUsers[ADMIN_USER_ID];
  }

  const existing = await getUserById(ADMIN_USER_ID);
  if (existing) {
    await query(
      `UPDATE users
       SET username = ?, real_name = ?, membership_type = 'monthly', membership_expires_at = ?, monthly_quota_used = 0, quota_period = ?, updated_at = ?
       WHERE id = ?`,
      [ADMIN_USERNAME, ADMIN_USERNAME, expiresAt, getQuotaPeriod(), now, ADMIN_USER_ID]
    );
    return getUserById(ADMIN_USER_ID);
  }

  const sameNameUser = await getUserByUsername(ADMIN_USERNAME);
  const adminUsername = sameNameUser ? `${ADMIN_USERNAME}_${ADMIN_USER_ID}` : ADMIN_USERNAME;
  await query(
    `INSERT INTO users
     (id, username, real_name, password_hash, points, free_quota_remaining, monthly_quota_used, quota_period, device_fingerprint, membership_type, membership_expires_at, registered_at, register_ip, open_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ADMIN_USER_ID,
      adminUsername,
      ADMIN_USERNAME,
      null,
      FREE_TRIAL_QUOTA,
      FREE_TRIAL_QUOTA,
      0,
      getQuotaPeriod(),
      null,
      'monthly',
      expiresAt,
      now,
      'admin',
      null,
      now,
      now,
    ]
  );
  return getUserById(ADMIN_USER_ID);
}

function normalizeIpRegistrationRecord(record) {
  if (record && typeof record === 'object') {
    const lastRegisteredAt = toSafeInt(record.last_registered_at || record.lastRegisteredAt || 0, 0);
    return {
      lastRegisteredAt,
      registerCount: toSafeInt(record.register_count || record.registerCount || 0, 0),
      windowStartAt: toSafeInt(record.window_start_at || record.windowStartAt || lastRegisteredAt, lastRegisteredAt),
    };
  }

  const lastRegisteredAt = toSafeInt(record || 0, 0);
  return {
    lastRegisteredAt,
    registerCount: lastRegisteredAt ? 1 : 0,
    windowStartAt: lastRegisteredAt,
  };
}

async function ensureRegistrationAllowed(clientIp, deviceFingerprint) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  if (useJsonStore) {
    const ipRecord = normalizeIpRegistrationRecord(jsonIpRegistrations[clientIp]);
    if (ipRecord.windowStartAt && now - ipRecord.windowStartAt < oneDay && ipRecord.registerCount >= IP_REGISTER_LIMIT_PER_DAY) {
      return { ok: false, status: 429, message: '当前网络注册过于频繁，请明天再试或联系管理员开通账号' };
    }

    if (deviceFingerprint) {
      const deviceRecord = jsonIpRegistrations[`device:${deviceFingerprint}`];
      const registeredAt = toSafeInt(deviceRecord?.registered_at || deviceRecord?.registeredAt || 0, 0);
      if (registeredAt && now - registeredAt < DEVICE_FREE_CLAIM_WINDOW_MS) {
        return { ok: false, status: 429, message: '当前设备已领取过免费体验次数，请直接登录原账号或联系管理员' };
      }
    }

    return { ok: true };
  }

  const ipRecord = await getOne('SELECT * FROM ip_registrations WHERE ip = ?', [clientIp]);
  if (ipRecord) {
    const windowStartAt = toSafeInt(ipRecord.window_start_at || ipRecord.last_registered_at || 0, 0);
    const registerCount = toSafeInt(ipRecord.register_count || 0, 0);
    if (windowStartAt && now - windowStartAt < oneDay && registerCount >= IP_REGISTER_LIMIT_PER_DAY) {
      return { ok: false, status: 429, message: '当前网络注册过于频繁，请明天再试或联系管理员开通账号' };
    }
  }

  if (deviceFingerprint) {
    const deviceRecord = await getOne('SELECT * FROM device_registrations WHERE device_fingerprint = ?', [deviceFingerprint]);
    const registeredAt = toSafeInt(deviceRecord?.registered_at || 0, 0);
    if (registeredAt && now - registeredAt < DEVICE_FREE_CLAIM_WINDOW_MS) {
      return { ok: false, status: 429, message: '当前设备已领取过免费体验次数，请直接登录原账号或联系管理员' };
    }
  }

  return { ok: true };
}

async function recordRegistration(clientIp, deviceFingerprint, userId) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  if (useJsonStore) {
    const ipRecord = normalizeIpRegistrationRecord(jsonIpRegistrations[clientIp]);
    const isNewWindow = !ipRecord.windowStartAt || now - ipRecord.windowStartAt >= oneDay;
    jsonIpRegistrations[clientIp] = {
      last_registered_at: now,
      register_count: isNewWindow ? 1 : ipRecord.registerCount + 1,
      window_start_at: isNewWindow ? now : ipRecord.windowStartAt,
    };
    if (deviceFingerprint) {
      jsonIpRegistrations[`device:${deviceFingerprint}`] = {
        user_id: userId,
        registered_at: now,
        last_ip: clientIp,
      };
    }
    persistJsonIpRegistrations();
    return;
  }

  const ipRecord = await getOne('SELECT * FROM ip_registrations WHERE ip = ?', [clientIp]);
  const windowStartAt = toSafeInt(ipRecord?.window_start_at || ipRecord?.last_registered_at || 0, 0);
  const isNewWindow = !windowStartAt || now - windowStartAt >= oneDay;
  const registerCount = isNewWindow ? 1 : toSafeInt(ipRecord?.register_count || 0, 0) + 1;
  await query(
    `INSERT INTO ip_registrations (ip, last_registered_at, register_count, window_start_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE last_registered_at = VALUES(last_registered_at), register_count = VALUES(register_count), window_start_at = VALUES(window_start_at)`,
    [clientIp, now, registerCount, isNewWindow ? now : windowStartAt]
  );

  if (deviceFingerprint) {
    await query(
      `INSERT INTO device_registrations (device_fingerprint, user_id, registered_at, last_ip)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), registered_at = VALUES(registered_at), last_ip = VALUES(last_ip)`,
      [deviceFingerprint, userId, now, clientIp]
    );
  }
}

function wxCodeToSession(code) {
  return new Promise((resolve, reject) => {
    if (!WX_APP_SECRET) {
      resolve(null);
      return;
    }

    const target = new URL('https://api.weixin.qq.com/sns/jscode2session');
    target.searchParams.set('appid', WX_APP_ID);
    target.searchParams.set('secret', WX_APP_SECRET);
    target.searchParams.set('js_code', code);
    target.searchParams.set('grant_type', 'authorization_code');

    https.get(target, (resp) => {
      const chunks = [];
      resp.on('data', (chunk) => chunks.push(chunk));
      resp.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.errcode) {
            reject(new Error(data.errmsg || `微信登录失败：${data.errcode}`));
            return;
          }
          resolve(data);
        } catch (error) {
          reject(new Error('微信登录响应解析失败'));
        }
      });
    }).on('error', reject);
  });
}

function makeDevOpenId(devOpenId, code) {
  const raw = devOpenId || code || `${Date.now()}_${Math.random()}`;
  return `wx_dev_${crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 24)}`;
}

async function loginWithWechat(params, clientIp) {
  const code = String(params.code || '').trim();
  if (!code) {
    const err = new Error('缺少微信登录 code');
    err.statusCode = 400;
    throw err;
  }

  const session = await wxCodeToSession(code);
  const openId = session?.openid || makeDevOpenId(params.devOpenId, code);
  const nickname = String(params.nickname || '').trim() || `微信用户${openId.slice(-6)}`;
  const deviceFingerprint = hashDeviceFingerprint(params.deviceFingerprint || params.clientFingerprint || '');
  let user = await getUserByOpenId(openId);
  let isNew = false;

  if (!user) {
    const allowResult = await ensureRegistrationAllowed(clientIp, deviceFingerprint);
    if (!allowResult.ok) {
      const err = new Error(allowResult.message);
      err.statusCode = allowResult.status;
      throw err;
    }

    const now = Date.now();
    const newId = `wx_${now}_${Math.random().toString(36).slice(2, 8)}`;
    let username = nickname;
    const existing = await getUserByUsername(username);
    if (existing) {
      username = `${nickname}_${openId.slice(-4)}`;
    }

    // 处理推荐人逻辑
    const inviterId = params.inviterId;
    let parentId = null;
    let grandParentId = null;
    if (inviterId && inviterId !== newId) {
      const inviter = await getUserById(inviterId);
      if (inviter) {
        parentId = inviter.id;
        grandParentId = inviter.parent_id || inviter.parentId || null;
      }
    }

    if (useJsonStore) {
      jsonUsers[newId] = {
        id: newId,
        username,
        real_name: nickname,
        password_hash: null,
        points: 0,
        free_quota_remaining: FREE_TRIAL_QUOTA,
        monthly_quota_used: 0,
        quota_period: getQuotaPeriod(),
        device_fingerprint: deviceFingerprint,
        membership_type: 'free',
        membership_expires_at: 0,
        registered_at: now,
        register_ip: clientIp,
        open_id: openId,
        parent_id: parentId,
        grand_parent_id: grandParentId,
        referral_count: 0,
        commission_points: 0,
        created_at: now,
        updated_at: now,
      };
      persistJsonUsers();
    } else {
      await query(
        `INSERT INTO users
         (id, username, real_name, password_hash, points, free_quota_remaining, monthly_quota_used, quota_period, device_fingerprint, membership_type, membership_expires_at, registered_at, register_ip, open_id, parent_id, grand_parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId, username, nickname, null, 0, FREE_TRIAL_QUOTA, 0, getQuotaPeriod(), deviceFingerprint, 'free', 0, now, clientIp, openId, parentId, grandParentId, now, now]
      );
    }

    await recordRegistration(clientIp, deviceFingerprint, newId);

    // 更新推荐人的邀请计数
    if (parentId) {
      await incrementReferralCount(parentId);
    }

    user = await getUserById(newId);
    isNew = true;
  }

  return { user: normalizeUser(user), isNew, devMode: !WX_APP_SECRET };
}

async function incrementReferralCount(userId) {
  if (useJsonStore) {
    if (jsonUsers[userId]) {
      jsonUsers[userId].referral_count = (jsonUsers[userId].referral_count || 0) + 1;
      persistJsonUsers();
    }
  } else {
    await query('UPDATE users SET referral_count = referral_count + 1 WHERE id = ?', [userId]);
  }
}

async function updateUserPoints(userId, delta, action, note) {
  const user = await getUserById(userId);
  if (!user) return null;

  if (useJsonStore) {
    const nextPoints = user.points + delta;
    if (nextPoints < 0) return null;

    user.points = nextPoints;
    user.updated_at = Date.now();
    jsonUsers[userId] = user;
    persistJsonUsers();
    
    // 如果是充值动作，处理分销奖励
    if (action === 'admin_recharge' && delta > 0) {
      await processReferralCommission(userId, delta);
    }
    
    return { ...user };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    const u = rows[0];
    if (!u) {
      await conn.rollback();
      return null;
    }

    const nextPoints = u.points + delta;
    if (nextPoints < 0) {
      await conn.rollback();
      return null;
    }

    await conn.execute(
      'UPDATE users SET points = ?, updated_at = ? WHERE id = ?',
      [nextPoints, Date.now(), userId]
    );
    await conn.execute(
      `INSERT INTO point_logs (user_id, change_amount, balance_after, action, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, delta, nextPoints, action, note || '', Date.now()]
    );
    await conn.commit();

    // 处理分销奖励
    if (action === 'admin_recharge' && delta > 0) {
      await processReferralCommission(userId, delta);
    }

    return { ...u, points: nextPoints };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function processReferralCommission(userId, rechargeAmount) {
  const user = await getUserById(userId);
  if (!user) return;

  const parentId = user.parent_id || user.parentId;
  const grandParentId = user.grand_parent_id || user.grandParentId;

  // 一级分销：15%
  if (parentId) {
    const commission1 = Math.floor(rechargeAmount * 0.15);
    if (commission1 > 0) {
      await awardCommission(parentId, commission1, `一级分销奖励：来自用户 ${userId} 的充值`);
    }
  }

  // 二级分销：5%
  if (grandParentId) {
    const commission2 = Math.floor(rechargeAmount * 0.05);
    if (commission2 > 0) {
      await awardCommission(grandParentId, commission2, `二级分销奖励：来自用户 ${userId} 的充值`);
    }
  }
}

async function awardCommission(userId, amount, note) {
  if (useJsonStore) {
    if (jsonUsers[userId]) {
      jsonUsers[userId].points = (jsonUsers[userId].points || 0) + amount;
      jsonUsers[userId].commission_points = (jsonUsers[userId].commission_points || 0) + amount;
      jsonUsers[userId].updated_at = Date.now();
      persistJsonUsers();
    }
  } else {
    await query(
      'UPDATE users SET points = points + ?, commission_points = commission_points + ?, updated_at = ? WHERE id = ?',
      [amount, amount, Date.now(), userId]
    );
  }
}

async function updateUserMembership(userId, membershipType) {
  const type = 'monthly';
  const now = Date.now();
  const membershipExpiresAt = now + MEMBERSHIP_DURATION_DAYS * 24 * 60 * 60 * 1000;

  if (useJsonStore) {
    const user = jsonUsers[userId];
    if (!user) {
      return null;
    }
    user.membership_type = type;
    user.membership_expires_at = membershipExpiresAt;
    user.monthly_quota_used = 0;
    user.quota_period = getQuotaPeriod();
    user.updated_at = now;
    jsonUsers[userId] = user;
    persistJsonUsers();
    return { ...user };
  }

  const user = await getUserById(userId);
  if (!user) {
    return null;
  }

  await query(
    'UPDATE users SET membership_type = ?, membership_expires_at = ?, monthly_quota_used = 0, quota_period = ?, updated_at = ? WHERE id = ?',
    [type, membershipExpiresAt, getQuotaPeriod(), now, userId]
  );
  return getUserById(userId);
}

async function updateUserFreeQuota(userId, delta, action, note) {
  const user = await getUserById(userId);
  if (!user) return null;

  if (useJsonStore) {
    const currentQuota = getFreeQuotaRemaining(user);
    const nextQuota = currentQuota + delta;
    if (nextQuota < 0) return null;

    user.free_quota_remaining = nextQuota;
    user.points = nextQuota;
    user.updated_at = Date.now();
    jsonUsers[userId] = user;
    persistJsonUsers();
    return { ...user };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    const u = rows[0];
    if (!u) {
      await conn.rollback();
      return null;
    }

    const nextQuota = getFreeQuotaRemaining(u) + delta;
    if (nextQuota < 0) {
      await conn.rollback();
      return null;
    }

    await conn.execute(
      'UPDATE users SET free_quota_remaining = ?, points = ?, updated_at = ? WHERE id = ?',
      [nextQuota, nextQuota, Date.now(), userId]
    );
    await conn.execute(
      `INSERT INTO point_logs (user_id, change_amount, balance_after, action, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, delta, nextQuota, action || 'quota_adjust', note || '', Date.now()]
    );
    await conn.commit();
    return { ...u, free_quota_remaining: nextQuota, points: nextQuota };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function consumeGenerationQuota(userId, quotaType, options = {}) {
  const now = Date.now();

  if (useJsonStore) {
    const user = jsonUsers[userId];
    if (!user) return null;

    if (quotaType === 'monthly') {
      const quota = buildQuotaSummary(user);
      if (!quota.isMember || quota.monthlyQuotaRemaining <= 0) return null;
      user.monthly_quota_used = quota.monthlyQuotaUsed + 1;
      user.quota_period = user.quota_period || getQuotaPeriod();
    } else {
      const freeQuotaRemaining = getFreeQuotaRemaining(user);
      if (freeQuotaRemaining <= 0) return null;
      user.free_quota_remaining = freeQuotaRemaining - 1;
      user.points = user.free_quota_remaining;
    }

    user.updated_at = now;
    jsonUsers[userId] = user;
    persistJsonUsers();
    return { ...user };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    const user = rows[0];
    if (!user) {
      await conn.rollback();
      return null;
    }

    let updatedUser = null;
    if (quotaType === 'monthly') {
      const quota = buildQuotaSummary(user);
      if (!quota.isMember || quota.monthlyQuotaRemaining <= 0) {
        await conn.rollback();
        return null;
      }
      const nextUsed = quota.monthlyQuotaUsed + 1;
      await conn.execute(
        'UPDATE users SET monthly_quota_used = ?, quota_period = ?, updated_at = ? WHERE id = ?',
        [nextUsed, user.quota_period || getQuotaPeriod(), now, userId]
      );
      updatedUser = { ...user, monthly_quota_used: nextUsed };
    } else {
      const freeQuotaRemaining = getFreeQuotaRemaining(user);
      if (freeQuotaRemaining <= 0) {
        await conn.rollback();
        return null;
      }
      const nextQuota = freeQuotaRemaining - 1;
      await conn.execute(
        'UPDATE users SET free_quota_remaining = ?, points = ?, updated_at = ? WHERE id = ?',
        [nextQuota, nextQuota, now, userId]
      );
      updatedUser = { ...user, free_quota_remaining: nextQuota, points: nextQuota };
    }

    await conn.execute(
      `INSERT INTO generation_logs (user_id, quota_type, quality, job_type, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        quotaType,
        options.quality || '',
        options.jobType || '',
        options.note || '',
        now,
      ]
    );
    await conn.commit();
    return updatedUser;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function getForwardHeaders(proxyRes) {
  return {
    'Content-Type': proxyRes.headers['content-type'] || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('文件未找到');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

async function ensureUserCanGenerate(userId) {
  const user = await getUserById(userId);
  if (!user) {
    return { ok: false, status: 401, body: { error: { message: '请先登录' } } };
  }

  const normalized = normalizeUser(user);
  if (normalized.isMember) {
    if (normalized.monthlyQuotaRemaining <= 0) {
      return {
        ok: false,
        status: 402,
        body: { error: { message: `本月会员次数已用完，月会员最多可生成 ${MONTHLY_MEMBER_QUOTA} 次` } },
      };
    }

    return { ok: true, user, quotaType: 'monthly' };
  }

  if (normalized.freeQuotaRemaining <= 0) {
    return {
      ok: false,
      status: 402,
      body: { error: { message: `免费次数已用完，请开通 ${MONTHLY_MEMBER_PRICE} 元月会员继续使用` } },
    };
  }

  return { ok: true, user, quotaType: 'free' };
}

function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [jobId, job] of generationJobs.entries()) {
    if (now - job.updatedAt > GENERATION_JOB_TTL_MS) {
      generationJobs.delete(jobId);
    }
  }
}

function parseApiImages(rawText) {
  const parsedImages = [];

  try {
    const data = JSON.parse(rawText);
    if (data.data && Array.isArray(data.data)) {
      data.data.forEach((item, index) => {
        if (item && (item.url || item.b64_json)) {
          parsedImages.push({
            url: item.url || null,
            b64: item.b64_json || null,
            index,
          });
        }
      });
      if (parsedImages.length > 0) {
        return parsedImages;
      }
    }
  } catch (error) {
    // Ignore and continue with NDJSON parsing.
  }

  const partialParts = {};
  const lines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'image_generation.completed' && obj.b64_json) {
        parsedImages.push({ url: null, b64: obj.b64_json, index: parsedImages.length });
      } else if (obj.type === 'image_generation.partial_image' && obj.b64_json) {
        const idx = obj.partial_image_index || 0;
        if (!partialParts[idx]) partialParts[idx] = [];
        partialParts[idx].push(obj.b64_json);
      } else if (obj.b64_json && !obj.type) {
        parsedImages.push({ url: null, b64: obj.b64_json, index: parsedImages.length });
      } else if (obj.data && Array.isArray(obj.data)) {
        obj.data.forEach((item) => {
          if (item && (item.url || item.b64_json)) {
            parsedImages.push({
              url: item.url || null,
              b64: item.b64_json || null,
              index: parsedImages.length,
            });
          }
        });
      }
    } catch (error) {
      // Ignore malformed non-JSON lines.
    }
  }

  for (const idx of Object.keys(partialParts).sort((a, b) => Number(a) - Number(b))) {
    parsedImages.push({
      url: null,
      b64: partialParts[idx].join(''),
      index: Number(idx),
    });
  }

  return parsedImages;
}

function parseApiErrorMessage(rawText, statusCode) {
  const normalizeExternalMessage = (message) => {
    const rawMessage = String(message || '').replace(/\(request id:[^)]+\)/ig, '').trim();
    const lower = rawMessage.toLowerCase();

    if (lower.includes('key error') || lower.includes('api key') || lower.includes('unauthorized') || statusCode === 401) {
      return '接口认证失败，请管理员检查 API 密钥是否属于当前接口平台，或检查接口地址是否填错';
    }

    if (lower.includes('quota') || lower.includes('credit') || lower.includes('balance') || lower.includes('insufficient')) {
      return 'API账户额度不足，请管理员检查接口账户余额';
    }

    if (!rawMessage) {
      return `生成失败，接口返回 HTTP ${statusCode}`;
    }

    return rawMessage.length > 160 ? `${rawMessage.slice(0, 160)}...` : rawMessage;
  };

  try {
    const data = JSON.parse(rawText);
    return normalizeExternalMessage(data.error?.message || data.message || `HTTP ${statusCode}`);
  } catch (error) {
    const firstLine = rawText.split('\n').map((line) => line.trim()).find(Boolean);
    return normalizeExternalMessage(firstLine || `HTTP ${statusCode}`);
  }
}

function parseRawRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestUpstream(targetUrl, headers, body, job) {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const options = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'POST',
      headers,
      timeout: UPSTREAM_REQUEST_TIMEOUT_MS,
      rejectUnauthorized: false,
    };

    const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        resolve({
          statusCode: proxyRes.statusCode || 502,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        });
      });
      proxyRes.on('error', reject);
    });

    proxyReq.on('error', (err) => {
      if (job.cancelRequested) {
        reject(new Error('GENERATION_CANCELLED'));
        return;
      }
      reject(err);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('UPSTREAM_TIMEOUT'));
    });

    job.activeRequest = proxyReq;
    proxyReq.write(body);
    proxyReq.end();
  });
}

async function runGenerationJob(job) {
  if (job.status === 'cancelled') {
    return;
  }

  job.status = 'processing';
  job.startedAt = Date.now();
  job.updatedAt = job.startedAt;

  try {
    const upstream = await requestUpstream(job.targetUrl, job.headers, job.body, job);

    if (job.cancelRequested || job.status === 'cancelled') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      return;
    }

    if (upstream.statusCode !== 200) {
      job.status = 'failed';
      job.errorMessage = parseApiErrorMessage(upstream.bodyText, upstream.statusCode);
      job.updatedAt = Date.now();
      console.error(`[生成任务] 上游返回失败 ${upstream.statusCode}: ${job.errorMessage}`);
      return;
    }

    const images = parseApiImages(upstream.bodyText);
    if (!images.length) {
      job.status = 'failed';
      job.errorMessage = 'API未返回图片';
      job.updatedAt = Date.now();
      return;
    }

    const actionLabel = job.type === 'multipart' ? `参考图生成(${job.quality})` : `普通生成(${job.quality})`;
    const updatedUser = await consumeGenerationQuota(job.user.id, job.quotaType, {
      quality: job.quality,
      jobType: job.type,
      note: actionLabel,
    });
    if (!updatedUser) {
      job.status = 'failed';
      job.errorMessage = '次数扣减失败，请检查是否有并发生成任务';
      job.updatedAt = Date.now();
      return;
    }

    job.status = 'completed';
    job.completedAt = Date.now();
    job.updatedAt = job.completedAt;
    job.result = {
      images,
      user: normalizeUser(updatedUser),
    };
    const normalizedUser = normalizeUser(updatedUser);
    console.log(`[扣次] 用户 ${updatedUser.username} 扣除 1 次，剩余 ${normalizedUser.quotaRemaining}`);
  } catch (error) {
    if (job.cancelRequested || error.message === 'GENERATION_CANCELLED') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      return;
    }

    job.status = 'failed';
      job.errorMessage = error.message === 'UPSTREAM_TIMEOUT'
      ? 'API请求超时（超过3分钟），请先尝试1K清晰度，或稍后重试'
      : `代理请求失败: ${error.message}`;
    job.updatedAt = Date.now();
    console.error('[生成任务] 执行失败:', error);
  } finally {
    job.activeRequest = null;
  }
}

async function createGenerationJob(req, res) {
  cleanupExpiredJobs();

  const contentType = req.headers['content-type'] || '';
  const userId = req.headers['x-user-id'];
  const requestedQuality = FIXED_IMAGE_QUALITY;
  const settings = await getAppSettings();

  if (!settings.apiEnabled) {
    sendJson(res, 503, { error: { message: 'API当前已禁用，请联系管理员' } });
    return;
  }

  if (!settings.apiKey || !settings.apiEndpoint) {
    sendJson(res, 503, { error: { message: '管理员尚未配置可用的API，请联系管理员' } });
    return;
  }

  const rawBody = await parseRawRequestBody(req);
  let quality = requestedQuality;
  let type = 'json';
  let targetUrl = new URL(settings.apiEndpoint || DEFAULT_APP_SETTINGS.apiEndpoint);
  let headers = {};

  if (contentType.includes('multipart/form-data')) {
    type = 'multipart';
    targetUrl = new URL((settings.apiEndpoint || DEFAULT_APP_SETTINGS.apiEndpoint).replace(/\/generations\/?$/, '/edits'));
    headers = {
      'Content-Type': contentType,
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Length': rawBody.length,
    };
  } else {
    let params;
    try {
      params = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch (error) {
      sendJson(res, 400, { error: { message: '请求数据格式错误' } });
      return;
    }

    quality = FIXED_IMAGE_QUALITY;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Length': rawBody.length,
    };
  }

  const authResult = await ensureUserCanGenerate(userId);
  if (!authResult.ok) {
    sendJson(res, authResult.status, authResult.body);
    return;
  }

  const jobId = createJobId();
  const job = {
    id: jobId,
    userId,
    user: authResult.user,
    quotaType: authResult.quotaType,
    quality,
    type,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    targetUrl,
    headers,
    body: rawBody,
    activeRequest: null,
    cancelRequested: false,
    errorMessage: '',
    result: null,
  };

  generationJobs.set(jobId, job);
  runGenerationJob(job).catch((error) => {
    job.status = 'failed';
    job.errorMessage = error.message || '生成任务执行失败';
    job.updatedAt = Date.now();
  });

  sendJson(res, 202, {
    success: true,
    jobId,
    status: job.status,
  });
}

function getGenerationJob(req, res, url) {
  cleanupExpiredJobs();
  const jobId = url.searchParams.get('id');
  const requesterId = req.headers['x-user-id'];
  const job = jobId ? generationJobs.get(jobId) : null;

  if (!job) {
    sendJson(res, 404, { error: '生成任务不存在或已过期' });
    return;
  }

  if (requesterId && requesterId !== job.userId) {
    sendJson(res, 403, { error: '无权查看该生成任务' });
    return;
  }

  sendJson(res, 200, {
    success: true,
    job: {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      updatedAt: job.updatedAt,
      errorMessage: job.errorMessage || '',
      result: job.status === 'completed' ? job.result : null,
    },
  });
}

async function cancelGenerationJob(req, res) {
  const { jobId } = await parseRequestBody(req);
  const userId = req.auth.userId;
  const job = jobId ? generationJobs.get(jobId) : null;

  if (!job) {
    sendJson(res, 404, { error: '生成任务不存在或已过期' });
    return;
  }

  if (userId && userId !== job.userId) {
    sendJson(res, 403, { error: '无权取消该生成任务' });
    return;
  }

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    sendJson(res, 200, { success: true, status: job.status });
    return;
  }

  job.cancelRequested = true;
  job.status = 'cancelled';
  job.updatedAt = Date.now();

  if (job.activeRequest) {
    job.activeRequest.destroy(new Error('GENERATION_CANCELLED'));
  }

  sendJson(res, 200, { success: true, status: 'cancelled' });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id, X-Quality, X-Device-Fingerprint');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // 所有私有接口统一验证会话，忽略客户端自报的用户身份。
    if (pathname.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        sendJson(res, 403, { error: '不允许跨站请求' });
        return;
      }
      req.auth = auth.session(req);
      if (pathname === '/api/health') {
        sendJson(res, 200, { success: true, database: useJsonStore ? 'local' : 'mysql' });
        return;
      }
      if (pathname === '/api/admin/login' && req.method === 'POST') {
        if (!auth.allowLogin(req)) { sendJson(res, 429, { error: '尝试过于频繁，请稍后重试' }); return; }
        const data = await parseRequestBody(req);
        if (!auth.checkPassword(data.password, process.env.ADMIN_PASSWORD)) {
          sendJson(res, 401, { error: '管理员密码错误或尚未配置' }); return;
        }
        auth.login(req, res, ADMIN_USER_ID, true);
        sendJson(res, 200, { success: true }); return;
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        auth.logout(req, res); sendJson(res, 200, { success: true }); return;
      }
      const publicRoute = (req.method === 'GET' && ['/api/settings/public', '/api/templates'].includes(pathname))
        || (req.method === 'POST' && pathname === '/api/login');
      if (!publicRoute && !req.auth) { sendJson(res, 401, { error: '请先登录' }); return; }
      if (pathname.startsWith('/api/admin/') && !req.auth?.admin) { sendJson(res, 403, { error: '需要管理员权限' }); return; }
      if (pathname === '/api/login' && !auth.allowLogin(req)) { sendJson(res, 429, { error: '尝试过于频繁，请稍后重试' }); return; }
      if (req.auth) req.headers['x-user-id'] = req.auth.userId;
    }
    if (req.method === 'POST' && pathname === '/api/wechat/login') {
      const data = await parseRequestBody(req);
      const clientIp = ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0]).trim();
      const result = await loginWithWechat(data, clientIp);
      sendJson(res, 200, { success: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const data = await parseRequestBody(req);
      const username = (data.username || '').trim();
      const password = (data.password || '').trim();
      const realName = (data.realName || '').trim();
      const isRegister = data.isRegister === true;
      const clientIp = ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0]).trim();
      const deviceFingerprint = hashDeviceFingerprint(data.deviceFingerprint || data.clientFingerprint || req.headers['x-device-fingerprint'] || '');

      if (!username || !password) {
        sendJson(res, 400, { error: '用户名和密码不能为空' });
        return;
      }

      if (isRegister && !realName) {
        sendJson(res, 400, { error: '注册时必须填写真实姓名' });
        return;
      }

      let user = await getUserByUsername(username);
      let isNew = false;

      if (isRegister) {
        if (user) {
          sendJson(res, 400, { error: '用户名已存在' });
          return;
        }

        const allowResult = await ensureRegistrationAllowed(clientIp, deviceFingerprint);
        if (!allowResult.ok) {
          sendJson(res, allowResult.status, { error: allowResult.message });
          return;
        }

        const now = Date.now();

        const newId = `uid_${now}`;
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        if (useJsonStore) {
          jsonUsers[newId] = {
            id: newId,
            username,
            real_name: realName,
            password_hash: passwordHash,
            points: 0,
            free_quota_remaining: FREE_TRIAL_QUOTA,
            monthly_quota_used: 0,
            quota_period: getQuotaPeriod(),
            device_fingerprint: deviceFingerprint,
            membership_type: 'free',
            membership_expires_at: 0,
            registered_at: now,
            register_ip: clientIp,
            open_id: null,
            created_at: now,
            updated_at: now,
          };
          persistJsonUsers();
        } else {
          await query(
            `INSERT INTO users
             (id, username, real_name, password_hash, points, free_quota_remaining, monthly_quota_used, quota_period, device_fingerprint, membership_type, membership_expires_at, registered_at, register_ip, open_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId, username, realName, passwordHash, 0, FREE_TRIAL_QUOTA, 0, getQuotaPeriod(), deviceFingerprint, 'free', 0, now, clientIp, null, now, now]
          );
        }
        await recordRegistration(clientIp, deviceFingerprint, newId);
        user = await getUserById(newId);
        isNew = true;
      } else {
        if (!user) {
          sendJson(res, 404, { error: '用户不存在' });
          return;
        }
        const passwordOk = user.password_hash
          ? await bcrypt.compare(password, user.password_hash)
          : false;
        if (!passwordOk) {
          sendJson(res, 401, { error: '密码错误' });
          return;
        }

      }

      auth.login(req, res, user.id);
      sendJson(res, 200, { success: true, user: normalizeUser(user), isNew });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/user') {
      const userId = req.auth.userId;
      const user = userId ? await getUserById(userId) : null;
      if (!user) {
        sendJson(res, 404, { error: '用户不存在' });
        return;
      }
      sendJson(res, 200, { success: true, user: normalizeUser(user) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/settings/public') {
      const settings = await getAppSettings();
      sendJson(res, 200, {
        success: true,
        settings: {
          apiEndpoint: settings.apiEndpoint,
          model: settings.model,
          apiEnabled: settings.apiEnabled,
          apiConfigured: !!settings.apiKey,
        },
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/templates') {
      const templates = await listUserTemplates(url.searchParams.get('category'));
      sendJson(res, 200, { success: true, templates });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/templates') {
      const data = await parseRequestBody(req);
      const template = await createUserTemplate({ ...data, userId: req.auth.userId });
      sendJson(res, 200, { success: true, template });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/settings') {
      const settings = await getAppSettings();
      sendJson(res, 200, { success: true, settings: { ...settings, apiKey: '', apiConfigured: !!settings.apiKey } });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/session') {
      const user = await ensureAdminUser();
      sendJson(res, 200, { success: true, user: normalizeUser(user) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/recharge') {
      sendJson(res, 403, { error: '请通过会员中心联系客服开通月会员' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/membership') {
      const { userId, membershipType } = await parseRequestBody(req);
      if (!userId || membershipType !== 'monthly') {
        sendJson(res, 400, { error: '会员升级失败' });
        return;
      }
      const updatedUser = await updateUserMembership(userId, membershipType);
      if (!updatedUser) {
        sendJson(res, 400, { error: '会员升级失败' });
        return;
      }
      sendJson(res, 200, { success: true, user: normalizeUser(updatedUser) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const users = useJsonStore
        ? Object.values(jsonUsers).sort((a, b) => b.registered_at - a.registered_at)
        : await query('SELECT * FROM users ORDER BY registered_at DESC');
      sendJson(res, 200, { success: true, users: users.map(normalizeUser) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/recharge') {
      const { userId, points, quota } = await parseRequestBody(req);
      const delta = parseInt(quota ?? points, 10);
      if (!userId || Number.isNaN(delta) || delta <= 0) {
        sendJson(res, 400, { error: '加次数失败' });
        return;
      }
      const updatedUser = await updateUserFreeQuota(userId, delta, 'admin_quota_add', '管理员手动增加免费次数');
      if (!updatedUser) {
        sendJson(res, 400, { error: '加次数失败' });
        return;
      }
      sendJson(res, 200, { success: true, user: normalizeUser(updatedUser) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/user/update') {
      const { username, realName } = await parseRequestBody(req);
      const userId = req.auth.userId;
      if (!userId || !username) {
        sendJson(res, 400, { error: '参数不完整' });
        return;
      }
      
      const now = Date.now();
      if (useJsonStore) {
        if (!jsonUsers[userId]) {
          sendJson(res, 404, { error: '用户不存在' });
          return;
        }
        jsonUsers[userId].username = username;
        jsonUsers[userId].real_name = realName;
        jsonUsers[userId].updated_at = now;
        persistJsonUsers();
        sendJson(res, 200, { success: true, user: normalizeUser(jsonUsers[userId]) });
      } else {
        await query(
          'UPDATE users SET username = ?, real_name = ?, updated_at = ? WHERE id = ?',
          [username, realName, now, userId]
        );
        const updatedUser = await getUserById(userId);
        sendJson(res, 200, { success: true, user: normalizeUser(updatedUser) });
      }
      return;
    }

    if (req.method === 'POST' && (pathname === '/api/admin/points' || pathname === '/api/admin/settings')) {
      const data = await parseRequestBody(req);
      const apiEndpoint = (data.apiEndpoint || '').trim();
      const previous = await getAppSettings();
      const apiKey = data.clearApiKey ? '' : ((data.apiKey || '').trim() || previous.apiKey);
      const model = (data.model || DEFAULT_APP_SETTINGS.model).trim();
      const apiEnabled = data.apiEnabled === true;

      if (!apiEndpoint) {
        sendJson(res, 400, { error: 'API接口地址不能为空' });
        return;
      }

      const settings = await saveAppSettings({
        apiEndpoint,
        apiKey,
        model,
        apiEnabled: apiEnabled && !!apiKey,
      });

      sendJson(res, 200, { success: true, settings: { ...settings, apiKey: '', apiConfigured: !!settings.apiKey } });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/deleteUser') {
      const { userId } = await parseRequestBody(req);
      const user = userId ? await getUserById(userId) : null;
      if (!user) {
        sendJson(res, 400, { error: '删除失败，用户不存在' });
        return;
      }
      if (useJsonStore) {
        delete jsonUsers[userId];
        persistJsonUsers();
      } else {
        await query('DELETE FROM users WHERE id = ?', [userId]);
      }
      sendJson(res, 200, { success: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/generate') {
      await createGenerationJob(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/generate/status') {
      getGenerationJob(req, res, url);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/generate/cancel') {
      await cancelGenerationJob(req, res);
      return;
    }

    let filePath;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(__dirname, 'index.html');
    } else {
      filePath = path.join(__dirname, decodeURIComponent(pathname));
    }

    const relative = path.relative(__dirname, filePath);
    const allowed = relative === 'index.html' ||
      (/^(图标素材|user_templates)[\\/]/.test(relative) && /\.(png|jpe?g|webp|gif|ico|lottie)$/i.test(relative));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !allowed) {
      res.writeHead(403);
      res.end('禁止访问');
      return;
    }

    serveFile(res, filePath);
  } catch (error) {
    console.error('[服务器] 错误:', error);
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : '服务器内部错误' });
  }
});

// 关闭默认请求超时，避免图片生成过程中连接被服务端提前断开。
server.requestTimeout = 0;
server.timeout = 0;

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log('');
      console.log(useJsonStore ? '  CYBER FORGE 本地 JSON 后端已启动' : '  CYBER FORGE MySQL 后端已启动');
      console.log('  ---------------------------');
      console.log(`  本地地址: http://localhost:${PORT}`);
      console.log(useJsonStore
        ? '  数据模式: JSON 本地兜底（启动 MySQL 后会自动使用数据库）'
        : `  MySQL: ${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}/${MYSQL_CONFIG.database}`);
      console.log('  按 Ctrl+C 停止服务器');
      console.log('');
    });
  })
  .catch((error) => {
    console.error('MySQL 初始化失败:', error.message);
    process.exit(1);
  });
