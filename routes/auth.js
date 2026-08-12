const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const { executeQuery } = require('../config/database');
const { signToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

let ssoTableReady = false;

async function ensureSsoTable() {
  if (ssoTableReady) return;
  // No FK — some cPanel MySQL setups reject ADD CONSTRAINT on ensure
  await executeQuery(`
    CREATE TABLE IF NOT EXISTS qms_sso_tokens (
      id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      token_hash   CHAR(64) NOT NULL,
      user_id      INT UNSIGNED NOT NULL,
      pos_email    VARCHAR(150) NULL,
      pos_role     VARCHAR(64) NULL,
      expires_at   DATETIME NOT NULL,
      used_at      DATETIME NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_qms_sso_token_hash (token_hash),
      KEY idx_qms_sso_expires (expires_at),
      KEY idx_qms_sso_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  ssoTableReady = true;
}

function mapRoleFromPos(posRole) {
  const r = String(posRole || '').toUpperCase();
  if (r === 'ADMIN') return 'super_admin';
  if (r === 'CASHIER') return 'branch_staff';
  return 'branch_staff';
}

function normalizeEmail(posEmail, posName) {
  const raw = String(posEmail || '').trim().toLowerCase();
  if (raw.includes('@')) return raw.slice(0, 150);
  const slug = String(posName || raw || 'pos-user')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'pos-user';
  return `${slug}@pos.petzone.pk`.slice(0, 150);
}

async function findOrCreatePosUser(posEmail, posName, posRole) {
  const email = normalizeEmail(posEmail, posName);
  const name = String(posName || email.split('@')[0]).trim().slice(0, 120) || 'POS User';
  const role = mapRoleFromPos(posRole);

  const existing = await executeQuery(
    'SELECT * FROM qms_users WHERE email = ? LIMIT 1',
    [email],
  );
  if (existing.length) {
    const user = existing[0];
    if (!user.is_active) {
      const err = new Error('Queue user is inactive');
      err.status = 403;
      throw err;
    }
    if (user.role !== role && role === 'super_admin') {
      await executeQuery('UPDATE qms_users SET role = ? WHERE id = ?', [role, user.id]);
      user.role = role;
    }
    return user;
  }

  const orgs = await executeQuery(
    'SELECT id FROM qms_organizations WHERE is_active = 1 ORDER BY id ASC LIMIT 1',
  );
  const orgId = orgs[0]?.id || null;
  const randomPass = crypto.randomBytes(24).toString('hex');
  const passwordHash = await bcrypt.hash(randomPass, 10);
  const result = await executeQuery(
    `INSERT INTO qms_users (org_id, branch_id, name, email, password_hash, role, is_active)
     VALUES (?, NULL, ?, ?, ?, ?, 1)`,
    [orgId, name, email, passwordHash, role],
  );

  return {
    id: result.insertId,
    org_id: orgId,
    branch_id: null,
    name,
    email,
    role,
    is_active: 1,
  };
}

function userPayload(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    org_id: user.org_id,
    branch_id: user.branch_id,
  };
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const users = await executeQuery(
      'SELECT * FROM qms_users WHERE email = ? AND is_active = 1 LIMIT 1',
      [email.toLowerCase().trim()],
    );

    if (!users.length) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = signToken({ userId: user.id, role: user.role });
    res.cookie('qms_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      success: true,
      token,
      user: userPayload(user),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('qms_token');
  res.json({ success: true });
});

router.get('/me', authMiddleware, async (req, res) => {
  res.json({ success: true, user: req.user });
});

/**
 * Called by POS multipos with shared secret.
 * Body: { posEmail, posName, posRole, redirectPath }
 * Header: x-qms-sso-secret
 */
router.post('/sso/mint', async (req, res) => {
  try {
    await ensureSsoTable();
    const secret = req.headers['x-qms-sso-secret'];
    const expected =
      process.env.SSO_SHARED_SECRET ||
      process.env.QMS_SSO_SECRET ||
      'petzone-qms-sso-shared-secret';
    if (!secret || secret !== expected) {
      return res.status(401).json({ success: false, message: 'Invalid SSO secret' });
    }

    const posEmail = String(req.body?.posEmail || '').trim();
    const posName = String(req.body?.posName || '').trim();
    const posRole = String(req.body?.posRole || '').trim();
    const redirectPath = String(req.body?.redirectPath || '/admin').trim() || '/admin';
    if (!posEmail && !posName) {
      return res.status(400).json({ success: false, message: 'posEmail required' });
    }

    const user = await findOrCreatePosUser(posEmail, posName, posRole);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await executeQuery(
      `INSERT INTO qms_sso_tokens (token_hash, user_id, pos_email, pos_role, expires_at)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 2 MINUTE))`,
      [tokenHash, user.id, normalizeEmail(posEmail, posName), posRole || null],
    );

    const appUrl = (
      process.env.QMS_APP_URL ||
      'https://queue-management.petzone.pk'
    ).replace(/\/$/, '');
    const path = redirectPath.startsWith('/') ? redirectPath : `/${redirectPath}`;
    const ssoUrl = `${appUrl}${path}?sso=${encodeURIComponent(rawToken)}`;

    return res.json({
      success: true,
      ssoToken: rawToken,
      expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      ssoUrl,
      user: userPayload(user),
    });
  } catch (err) {
    console.error('QMS SSO mint error', err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'SSO mint failed',
    });
  }
});

/** Frontend exchanges one-time SSO token for JWT */
router.post('/sso/exchange', async (req, res) => {
  try {
    await ensureSsoTable();
    const rawToken = String(req.body?.ssoToken || req.body?.token || '').trim();
    if (!rawToken) {
      return res.status(400).json({ success: false, message: 'ssoToken required' });
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const rows = await executeQuery(
      `SELECT t.id, t.user_id, t.expires_at, t.used_at,
              u.id AS uid, u.name, u.email, u.role, u.org_id, u.branch_id, u.is_active
       FROM qms_sso_tokens t
       JOIN qms_users u ON u.id = t.user_id
       WHERE t.token_hash = ?
       LIMIT 1`,
      [tokenHash],
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid SSO token' });
    }
    const row = rows[0];
    if (row.used_at) {
      return res.status(401).json({ success: false, message: 'SSO token already used' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ success: false, message: 'SSO token expired' });
    }
    if (!row.is_active) {
      return res.status(403).json({ success: false, message: 'Account inactive' });
    }

    await executeQuery('UPDATE qms_sso_tokens SET used_at = NOW() WHERE id = ?', [row.id]);

    const user = {
      id: row.uid,
      name: row.name,
      email: row.email,
      role: row.role,
      org_id: row.org_id,
      branch_id: row.branch_id,
    };
    const token = signToken({ userId: user.id, role: user.role });
    res.cookie('qms_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      token,
      user: userPayload(user),
    });
  } catch (err) {
    console.error('QMS SSO exchange error', err);
    return res.status(500).json({ success: false, message: 'SSO exchange failed' });
  }
});

module.exports = router;
