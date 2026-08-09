const express = require('express');
const bcrypt = require('bcrypt');
const { pool, executeQuery } = require('../config/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getManagedBranch(req, branchId) {
  const rows = await executeQuery(
    `SELECT b.id, b.org_id, b.name
     FROM qms_branches b
     WHERE b.id = ?
     LIMIT 1`,
    [branchId]
  );
  const branch = rows[0] || null;
  if (!branch) return null;
  if (req.user.role === 'super_admin') return branch;
  if (req.user.role === 'org_admin' && branch.org_id === req.user.org_id) return branch;
  return null;
}

async function getPrimaryService(branchId) {
  const preferred = await executeQuery(
    `SELECT id, name, prefix
     FROM qms_service_types
     WHERE branch_id = ? AND is_active = 1
     ORDER BY
       CASE WHEN LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%' THEN 0 ELSE 1 END,
       display_order,
       id
     LIMIT 1`,
    [branchId]
  );
  return preferred[0] || null;
}

// ── Organizations (super_admin only) ────────────────────────
router.get('/organizations', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const orgs = await executeQuery(`
      SELECT o.*,
        (SELECT COUNT(*) FROM qms_branches b WHERE b.org_id = o.id) AS branch_count
      FROM qms_organizations o
      ORDER BY o.name
    `);
    res.json({ success: true, data: orgs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/organizations', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { name, slug } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });

    const finalSlug = slugify(slug || name);
    const result = await executeQuery(
      'INSERT INTO qms_organizations (name, slug) VALUES (?, ?)',
      [name.trim(), finalSlug]
    );
    res.status(201).json({ success: true, id: result.insertId, slug: finalSlug });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Organization slug already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/organizations/:id', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { name, is_active } = req.body;
    await executeQuery(
      'UPDATE qms_organizations SET name = COALESCE(?, name), is_active = COALESCE(?, is_active) WHERE id = ?',
      [name, is_active, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Branches ────────────────────────────────────────────────
router.get('/branches', authMiddleware, async (req, res) => {
  try {
    let query = `
      SELECT b.*, o.name AS org_name, o.slug AS org_slug
      FROM qms_branches b
      JOIN qms_organizations o ON o.id = b.org_id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role === 'org_admin') {
      query += ' AND b.org_id = ?';
      params.push(req.user.org_id);
    } else if (req.user.role === 'branch_staff') {
      query += ' AND b.id = ?';
      params.push(req.user.branch_id);
    } else if (req.query.org_id) {
      query += ' AND b.org_id = ?';
      params.push(req.query.org_id);
    }

    query += ' ORDER BY o.name, b.name';
    const branches = await executeQuery(query, params);
    const safe = branches.map((b) => {
      const { counter_pin, kiosk_pin, ...rest } = b;
      return {
        ...rest,
        has_counter_pin: Boolean(counter_pin && String(counter_pin).trim()),
        has_kiosk_pin: Boolean(kiosk_pin && String(kiosk_pin).trim()),
      };
    });
    res.json({ success: true, data: safe });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/branches', authMiddleware, requireRole('super_admin', 'org_admin'), async (req, res) => {
  try {
    const { org_id, name, slug, address, phone } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });

    let orgId = org_id;
    if (req.user.role === 'org_admin') orgId = req.user.org_id;
    if (!orgId) return res.status(400).json({ success: false, message: 'Organization required' });

    const finalSlug = slugify(slug || name);
    const result = await executeQuery(
      'INSERT INTO qms_branches (org_id, name, slug, address, phone) VALUES (?, ?, ?, ?, ?)',
      [orgId, name.trim(), finalSlug, address || null, phone || null]
    );

    const branchId = result.insertId;
    const defaultServices = [
      { name: 'General Consultation', prefix: 'C', color: '#1E3A8A', order: 1 },
      { name: 'Vaccination', prefix: 'V', color: '#059669', order: 2 },
      { name: 'Grooming', prefix: 'G', color: '#D97706', order: 3 },
      { name: 'Emergency', prefix: 'E', color: '#DC2626', order: 4 },
    ];

    for (const svc of defaultServices) {
      await executeQuery(
        'INSERT INTO qms_service_types (branch_id, name, prefix, color, display_order) VALUES (?, ?, ?, ?, ?)',
        [branchId, svc.name, svc.prefix, svc.color, svc.order]
      );
    }

    res.status(201).json({ success: true, id: branchId, slug: finalSlug });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Branch slug already exists in this organization' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/branches/:id', authMiddleware, requireRole('super_admin', 'org_admin'), async (req, res) => {
  try {
    const { name, address, phone, is_active, counter_pin, kiosk_pin } = req.body;
    await executeQuery(
      `UPDATE qms_branches SET
        name = COALESCE(?, name),
        address = COALESCE(?, address),
        phone = COALESCE(?, phone),
        is_active = COALESCE(?, is_active)
      WHERE id = ?`,
      [name, address, phone, is_active, req.params.id]
    );

    // Screen PINs: string sets/updates; empty string clears; omit leaves unchanged
    if (Object.prototype.hasOwnProperty.call(req.body, 'counter_pin')) {
      const pin = counter_pin == null ? '' : String(counter_pin).trim().slice(0, 32);
      await executeQuery(
        `UPDATE qms_branches SET counter_pin = ? WHERE id = ?`,
        [pin || null, req.params.id]
      );
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'kiosk_pin')) {
      const pin = kiosk_pin == null ? '' : String(kiosk_pin).trim().slice(0, 32);
      await executeQuery(
        `UPDATE qms_branches SET kiosk_pin = ? WHERE id = ?`,
        [pin || null, req.params.id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Manual queue numbering (shared by all categories) ───
router.get(
  '/branches/:branchId/sequence',
  authMiddleware,
  requireRole('super_admin', 'org_admin'),
  async (req, res) => {
    try {
      const branch = await getManagedBranch(req, parseInt(req.params.branchId, 10));
      if (!branch) {
        return res.status(404).json({ success: false, message: 'Branch not found or not permitted' });
      }

      const service = await getPrimaryService(branch.id);
      if (!service) {
        return res.status(404).json({ success: false, message: 'No active queue service configured' });
      }

      const dateKey = todayKey();
      const rows = await executeQuery(
        `SELECT
           COALESCE(MAX(s.last_number), 0) AS last_number,
           COALESCE((
             SELECT MAX(t.ticket_number)
             FROM qms_tickets t
             WHERE t.branch_id = ? AND t.date_key = ?
           ), 0) AS highest_issued
         FROM (SELECT 1) seed
         LEFT JOIN qms_daily_sequences s
           ON s.branch_id = ? AND s.service_type_id = ? AND s.date_key = ?`,
        [branch.id, dateKey, branch.id, service.id, dateKey]
      );

      const lastNumber = Number(rows[0]?.last_number || 0);
      const highestIssued = Number(rows[0]?.highest_issued || 0);
      res.json({
        success: true,
        data: {
          branch_id: branch.id,
          branch_name: branch.name,
          service_id: service.id,
          service_name: 'All categories (shared)',
          date_key: dateKey,
          last_number: lastNumber,
          highest_issued: highestIssued,
          next_number: Math.max(lastNumber, highestIssued) + 1,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.patch(
  '/branches/:branchId/sequence',
  authMiddleware,
  requireRole('super_admin', 'org_admin'),
  async (req, res) => {
    try {
      const nextNumber = Number(req.body.next_number);
      if (!Number.isInteger(nextNumber) || nextNumber < 1 || nextNumber > 999999) {
        return res.status(400).json({
          success: false,
          message: 'Next number must be a whole number from 1 to 999999',
        });
      }

      const branch = await getManagedBranch(req, parseInt(req.params.branchId, 10));
      if (!branch) {
        return res.status(404).json({ success: false, message: 'Branch not found or not permitted' });
      }
      const service = await getPrimaryService(branch.id);
      if (!service) {
        return res.status(404).json({ success: false, message: 'No active queue service configured' });
      }

      const dateKey = todayKey();
      const existing = await executeQuery(
        `SELECT COALESCE(MAX(ticket_number), 0) AS highest_issued
         FROM qms_tickets
         WHERE branch_id = ? AND date_key = ?`,
        [branch.id, dateKey]
      );
      const highestIssued = Number(existing[0]?.highest_issued || 0);
      if (nextNumber <= highestIssued) {
        return res.status(409).json({
          success: false,
          message: `Number ${nextNumber} was already reached today. Choose ${highestIssued + 1} or higher, or reset today first.`,
        });
      }

      await executeQuery(
        `INSERT INTO qms_daily_sequences
           (branch_id, service_type_id, date_key, last_number)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_number = VALUES(last_number)`,
        [branch.id, service.id, dateKey, nextNumber - 1]
      );

      res.json({
        success: true,
        message: `Next token for all categories at ${branch.name} will be ${nextNumber}`,
        data: { next_number: nextNumber },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.delete(
  '/branches/:branchId/sequence/today',
  authMiddleware,
  requireRole('super_admin', 'org_admin'),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const branch = await getManagedBranch(req, parseInt(req.params.branchId, 10));
      if (!branch) {
        return res.status(404).json({ success: false, message: 'Branch not found or not permitted' });
      }
      const service = await getPrimaryService(branch.id);
      if (!service) {
        return res.status(404).json({ success: false, message: 'No active queue service configured' });
      }

      const dateKey = todayKey();
      await conn.beginTransaction();
      const [deleted] = await conn.execute(
        `DELETE FROM qms_tickets
         WHERE branch_id = ? AND date_key = ?`,
        [branch.id, dateKey]
      );
      await conn.execute(
        `DELETE FROM qms_daily_sequences
         WHERE branch_id = ? AND date_key = ?`,
        [branch.id, dateKey]
      );
      await conn.commit();

      res.json({
        success: true,
        message: `${branch.name} reset for all categories. The next token will be 1.`,
        data: { deleted_tickets: deleted.affectedRows, next_number: 1 },
      });
    } catch (err) {
      await conn.rollback();
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);

// ── Service Types ───────────────────────────────────────────
router.get('/branches/:branchId/services', authMiddleware, async (req, res) => {
  try {
    const services = await executeQuery(
      'SELECT * FROM qms_service_types WHERE branch_id = ? ORDER BY display_order, name',
      [req.params.branchId]
    );
    res.json({ success: true, data: services });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/branches/:branchId/services', authMiddleware, requireRole('super_admin', 'org_admin'), async (req, res) => {
  try {
    const { name, prefix, color, display_order } = req.body;
    const result = await executeQuery(
      'INSERT INTO qms_service_types (branch_id, name, prefix, color, display_order) VALUES (?, ?, ?, ?, ?)',
      [req.params.branchId, name, (prefix || 'A').toUpperCase().slice(0, 5), color || '#1E3A8A', display_order || 0]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Counters ─────────────────────────────────────────────────
router.get('/branches/:branchId/counters', authMiddleware, async (req, res) => {
  try {
    const counters = await executeQuery(
      `SELECT c.*, s.name AS service_name, s.prefix AS service_prefix
       FROM qms_counters c
       LEFT JOIN qms_service_types s ON s.id = c.service_type_id
       WHERE c.branch_id = ?
       ORDER BY c.name`,
      [req.params.branchId]
    );
    res.json({ success: true, data: counters });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/branches/:branchId/counters', authMiddleware, requireRole('super_admin', 'org_admin'), async (req, res) => {
  try {
    const { name, service_type_id } = req.body;
    const result = await executeQuery(
      'INSERT INTO qms_counters (branch_id, name, service_type_id) VALUES (?, ?, ?)',
      [req.params.branchId, name, service_type_id || null]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Users ────────────────────────────────────────────────────
router.get('/users', authMiddleware, requireRole('super_admin', 'org_admin'), async (req, res) => {
  try {
    let query = `
      SELECT u.id, u.name, u.email, u.role, u.is_active, u.org_id, u.branch_id,
             o.name AS org_name, b.name AS branch_name
      FROM qms_users u
      LEFT JOIN qms_organizations o ON o.id = u.org_id
      LEFT JOIN qms_branches b ON b.id = u.branch_id
      WHERE 1=1
    `;
    const params = [];
    if (req.user.role === 'org_admin') {
      query += ' AND u.org_id = ?';
      params.push(req.user.org_id);
    }
    query += ' ORDER BY u.name';
    const users = await executeQuery(query, params);
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/users', authMiddleware, requireRole('super_admin', 'org_admin'), async (req, res) => {
  try {
    const { name, email, password, role, org_id, branch_id } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password required' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await executeQuery(
      'INSERT INTO qms_users (org_id, branch_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [org_id || req.user.org_id, branch_id || null, name, email.toLowerCase(), hash, role || 'branch_staff']
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
