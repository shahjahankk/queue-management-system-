const express = require('express');
const { pool, executeQuery } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getBranchBySlug(orgSlug, branchSlug) {
  const rows = await executeQuery(
    `SELECT b.*, o.name AS org_name, o.slug AS org_slug
     FROM qms_branches b
     JOIN qms_organizations o ON o.id = b.org_id
     WHERE o.slug = ? AND b.slug = ? AND b.is_active = 1 AND o.is_active = 1
     LIMIT 1`,
    [orgSlug, branchSlug]
  );
  return rows[0] || null;
}

async function getBranchByPosId(posBranchId) {
  const rows = await executeQuery(
    `SELECT b.*, o.name AS org_name, o.slug AS org_slug
     FROM qms_branches b
     JOIN qms_organizations o ON o.id = b.org_id
     WHERE b.pos_branch_id = ? AND b.is_active = 1 AND o.is_active = 1
     LIMIT 1`,
    [posBranchId]
  );
  return rows[0] || null;
}

async function getConsultationService(branchId) {
  const preferred = await executeQuery(
    `SELECT * FROM qms_service_types
     WHERE branch_id = ? AND is_active = 1
       AND (LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%')
     ORDER BY display_order, id
     LIMIT 1`,
    [branchId]
  );
  if (preferred.length) return preferred[0];

  const rows = await executeQuery(
    'SELECT * FROM qms_service_types WHERE branch_id = ? AND is_active = 1 ORDER BY display_order, id LIMIT 1',
    [branchId]
  );
  return rows[0] || null;
}

// Resolve QMS branch from POS branch id (public — used by POS frontend)
router.get('/resolve', async (req, res) => {
  try {
    const posBranchId = req.query.posBranchId ? parseInt(req.query.posBranchId, 10) : null;
    let branch = posBranchId ? await getBranchByPosId(posBranchId) : null;

    if (!branch) {
      const fallback = await executeQuery(
        `SELECT b.*, o.name AS org_name, o.slug AS org_slug
         FROM qms_branches b JOIN qms_organizations o ON o.id = b.org_id
         WHERE b.is_active = 1 AND o.is_active = 1 ORDER BY b.id LIMIT 1`
      );
      branch = fallback[0] || null;
    }

    if (!branch) {
      return res.status(404).json({ success: false, message: 'No queue branch configured' });
    }

    res.json({
      success: true,
      data: {
        qmsBranchId: branch.id,
        orgSlug: branch.org_slug,
        branchSlug: branch.slug,
        branchName: branch.name,
        posBranchId: branch.pos_branch_id,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Simple token: plain number 28, 29, 30 … (consultancy only) ──
router.post('/public/:orgSlug/:branchSlug/token', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const service = await getConsultationService(branch.id);
    if (!service) {
      return res.status(400).json({ success: false, message: 'No consultancy service configured for this branch' });
    }

    const dateKey = todayKey();

    await conn.beginTransaction();

    await conn.execute(
      `INSERT INTO qms_daily_sequences (branch_id, service_type_id, date_key, last_number)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
      [branch.id, service.id, dateKey]
    );

    const [seqRows] = await conn.execute(
      'SELECT last_number FROM qms_daily_sequences WHERE branch_id = ? AND service_type_id = ? AND date_key = ?',
      [branch.id, service.id, dateKey]
    );
    const ticketNumber = seqRows[0].last_number;
    const ticketCode = String(ticketNumber);

    const [insertResult] = await conn.execute(
      `INSERT INTO qms_tickets
        (branch_id, service_type_id, ticket_number, ticket_code, date_key)
       VALUES (?, ?, ?, ?, ?)`,
      [branch.id, service.id, ticketNumber, ticketCode, dateKey]
    );

    await conn.commit();

    res.status(201).json({
      success: true,
      data: {
        id: insertResult.insertId,
        ticket_code: ticketCode,
        ticket_number: ticketNumber,
        branch_name: branch.name,
        issued_at: new Date().toISOString(),
        date_key: dateKey,
      },
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// ── Public: branch info + services (kiosk/display) ──────────
router.get('/public/:orgSlug/:branchSlug', async (req, res) => {
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const consultation = await getConsultationService(branch.id);
    const services = consultation ? [{
      id: consultation.id,
      name: consultation.name,
      prefix: consultation.prefix,
      color: consultation.color,
      display_order: consultation.display_order,
    }] : [];

    res.json({
      success: true,
      data: {
        branch: { id: branch.id, name: branch.name, slug: branch.slug, address: branch.address },
        org: { name: branch.org_name, slug: branch.org_slug },
        services,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Issue a new ticket (kiosk - no auth required) ───────────
router.post('/public/:orgSlug/:branchSlug/tickets', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const { service_type_id, pet_name, owner_name } = req.body;
    if (!service_type_id) {
      return res.status(400).json({ success: false, message: 'Service type required' });
    }

    const services = await executeQuery(
      'SELECT * FROM qms_service_types WHERE id = ? AND branch_id = ? AND is_active = 1 LIMIT 1',
      [service_type_id, branch.id]
    );
    if (!services.length) {
      return res.status(400).json({ success: false, message: 'Invalid service type' });
    }
    const service = services[0];
    const dateKey = todayKey();

    await conn.beginTransaction();

    await conn.execute(
      `INSERT INTO qms_daily_sequences (branch_id, service_type_id, date_key, last_number)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
      [branch.id, service.id, dateKey]
    );

    const [seqRows] = await conn.execute(
      'SELECT last_number FROM qms_daily_sequences WHERE branch_id = ? AND service_type_id = ? AND date_key = ?',
      [branch.id, service.id, dateKey]
    );
    const ticketNumber = seqRows[0].last_number;
    const ticketCode = `${service.prefix}${String(ticketNumber).padStart(3, '0')}`;

    const [insertResult] = await conn.execute(
      `INSERT INTO qms_tickets
        (branch_id, service_type_id, ticket_number, ticket_code, pet_name, owner_name, date_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [branch.id, service.id, ticketNumber, ticketCode, pet_name || null, owner_name || null, dateKey]
    );

    await conn.commit();

    const waitingCount = await executeQuery(
      `SELECT COUNT(*) AS cnt FROM qms_tickets
       WHERE branch_id = ? AND service_type_id = ? AND date_key = ? AND status = 'waiting'`,
      [branch.id, service.id, dateKey]
    );

    res.status(201).json({
      success: true,
      data: {
        id: insertResult.insertId,
        ticket_code: ticketCode,
        ticket_number: ticketNumber,
        service_name: service.name,
        prefix: service.prefix,
        color: service.color,
        pet_name: pet_name || null,
        owner_name: owner_name || null,
        branch_name: branch.name,
        org_name: branch.org_name,
        issued_at: new Date().toISOString(),
        waiting_ahead: Math.max(0, waitingCount[0].cnt - 1),
        date_key: dateKey,
      },
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// ── Live queue status (display screen) ──────────────────────
router.get('/public/:orgSlug/:branchSlug/status', async (req, res) => {
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const dateKey = todayKey();

    const nowServing = await executeQuery(
      `SELECT t.ticket_code, t.status, t.called_at,
              s.name AS service_name, s.prefix, s.color,
              c.name AS counter_name
       FROM qms_tickets t
       JOIN qms_service_types s ON s.id = t.service_type_id
       LEFT JOIN qms_counters c ON c.id = t.counter_id
       WHERE t.branch_id = ? AND t.date_key = ? AND t.status IN ('called','serving')
       ORDER BY t.called_at DESC
       LIMIT 10`,
      [branch.id, dateKey]
    );

    const waitingByService = await executeQuery(
      `SELECT s.id, s.name, s.prefix, s.color,
              COUNT(t.id) AS waiting_count,
              MIN(t.ticket_code) AS next_ticket
       FROM qms_service_types s
       LEFT JOIN qms_tickets t ON t.service_type_id = s.id
         AND t.branch_id = ? AND t.date_key = ? AND t.status = 'waiting'
       WHERE s.branch_id = ? AND s.is_active = 1
       GROUP BY s.id
       ORDER BY s.display_order`,
      [branch.id, dateKey, branch.id]
    );

    const recentlyCompleted = await executeQuery(
      `SELECT t.ticket_code, s.name AS service_name, s.color, t.completed_at
       FROM qms_tickets t
       JOIN qms_service_types s ON s.id = t.service_type_id
       WHERE t.branch_id = ? AND t.date_key = ? AND t.status = 'completed'
       ORDER BY t.completed_at DESC LIMIT 5`,
      [branch.id, dateKey]
    );

    res.json({
      success: true,
      data: {
        branch: { name: branch.name, org_name: branch.org_name },
        date_key: dateKey,
        now_serving: nowServing,
        waiting_by_service: waitingByService,
        recently_completed: recentlyCompleted,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Public staff counter (no auth — for clinic tablets) ─────
router.post('/public/:orgSlug/:branchSlug/call-next', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const { counter_id } = req.body;
    const consultation = await getConsultationService(branch.id);
    if (!consultation) {
      return res.status(400).json({ success: false, message: 'No consultancy service configured for this branch' });
    }
    const dateKey = todayKey();

    await conn.beginTransaction();

    let query = `
      SELECT t.id FROM qms_tickets t
      WHERE t.branch_id = ? AND t.date_key = ? AND t.status = 'waiting'
    `;
    const params = [branch.id, dateKey];
    query += ' AND t.service_type_id = ?';
    params.push(consultation.id);
    query += ' ORDER BY t.ticket_number ASC LIMIT 1 FOR UPDATE';

    const [waiting] = await conn.execute(query, params);
    if (!waiting.length) {
      await conn.rollback();
      return res.json({ success: true, data: null, message: 'No waiting tickets' });
    }

    const ticketId = waiting[0].id;
    await conn.execute(
      `UPDATE qms_tickets SET status = 'called', called_at = NOW(), counter_id = ? WHERE id = ?`,
      [counter_id || null, ticketId]
    );
    await conn.commit();

    const ticket = await executeQuery(
      `SELECT t.*, s.name AS service_name, s.prefix, s.color, c.name AS counter_name
       FROM qms_tickets t
       JOIN qms_service_types s ON s.id = t.service_type_id
       LEFT JOIN qms_counters c ON c.id = t.counter_id WHERE t.id = ?`,
      [ticketId]
    );
    res.json({ success: true, data: ticket[0] });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

router.patch('/public/tickets/:ticketId', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const extra = status === 'completed' ? ', completed_at = NOW()' : '';
    await executeQuery(`UPDATE qms_tickets SET status = ? ${extra} WHERE id = ?`, [status, req.params.ticketId]);
    const ticket = await executeQuery(
      `SELECT t.*, s.name AS service_name, s.prefix, s.color FROM qms_tickets t
       JOIN qms_service_types s ON s.id = t.service_type_id WHERE t.id = ?`,
      [req.params.ticketId]
    );
    res.json({ success: true, data: ticket[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/public/tickets/:ticketId/recall', async (req, res) => {
  try {
    await executeQuery(`UPDATE qms_tickets SET status = 'called', called_at = NOW() WHERE id = ?`, [req.params.ticketId]);
    const ticket = await executeQuery(
      `SELECT t.*, s.name AS service_name, s.prefix, s.color, c.name AS counter_name
       FROM qms_tickets t JOIN qms_service_types s ON s.id = t.service_type_id
       LEFT JOIN qms_counters c ON c.id = t.counter_id WHERE t.id = ?`,
      [req.params.ticketId]
    );
    res.json({ success: true, data: ticket[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/public/:orgSlug/:branchSlug/queue', async (req, res) => {
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const dateKey = todayKey();
    const consultation = await getConsultationService(branch.id);
    if (!consultation) {
      return res.status(400).json({ success: false, message: 'No consultancy service configured for this branch' });
    }
    let query = `
      SELECT t.*, s.name AS service_name, s.prefix, s.color, c.name AS counter_name
      FROM qms_tickets t
      JOIN qms_service_types s ON s.id = t.service_type_id
      LEFT JOIN qms_counters c ON c.id = t.counter_id
      WHERE t.branch_id = ? AND t.date_key = ? AND t.status IN ('waiting','called','serving')
    `;
    const params = [branch.id, dateKey];
    query += ' AND t.service_type_id = ?';
    params.push(consultation.id);
    query += ' ORDER BY t.ticket_number ASC';

    const tickets = await executeQuery(query, params);
    res.json({ success: true, data: tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Staff: get queue for counter ────────────────────────────
router.get('/staff/:branchId/queue', authMiddleware, async (req, res) => {
  try {
    const dateKey = todayKey();
    const { service_type_id, status } = req.query;

    let query = `
      SELECT t.*, s.name AS service_name, s.prefix, s.color, c.name AS counter_name
      FROM qms_tickets t
      JOIN qms_service_types s ON s.id = t.service_type_id
      LEFT JOIN qms_counters c ON c.id = t.counter_id
      WHERE t.branch_id = ? AND t.date_key = ?
    `;
    const params = [req.params.branchId, dateKey];

    if (service_type_id) {
      query += ' AND t.service_type_id = ?';
      params.push(service_type_id);
    }
    if (status) {
      query += ' AND t.status = ?';
      params.push(status);
    } else {
      query += " AND t.status IN ('waiting','called','serving')";
    }

    query += ' ORDER BY t.ticket_number ASC';
    const tickets = await executeQuery(query, params);
    res.json({ success: true, data: tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Staff: call next ticket ─────────────────────────────────
router.post('/staff/:branchId/call-next', authMiddleware, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { service_type_id, counter_id } = req.body;
    const dateKey = todayKey();

    await conn.beginTransaction();

    let query = `
      SELECT t.id FROM qms_tickets t
      WHERE t.branch_id = ? AND t.date_key = ? AND t.status = 'waiting'
    `;
    const params = [req.params.branchId, dateKey];

    if (service_type_id) {
      query += ' AND t.service_type_id = ?';
      params.push(service_type_id);
    }
    query += ' ORDER BY t.ticket_number ASC LIMIT 1 FOR UPDATE';

    const [waiting] = await conn.execute(query, params);
    if (!waiting.length) {
      await conn.rollback();
      return res.json({ success: true, data: null, message: 'No waiting tickets' });
    }

    const ticketId = waiting[0].id;
    await conn.execute(
      `UPDATE qms_tickets SET status = 'called', called_at = NOW(), counter_id = ? WHERE id = ?`,
      [counter_id || null, ticketId]
    );

    await conn.commit();

    const ticket = await executeQuery(
      `SELECT t.*, s.name AS service_name, s.prefix, s.color, c.name AS counter_name
       FROM qms_tickets t
       JOIN qms_service_types s ON s.id = t.service_type_id
       LEFT JOIN qms_counters c ON c.id = t.counter_id
       WHERE t.id = ?`,
      [ticketId]
    );

    res.json({ success: true, data: ticket[0] });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// ── Staff: update ticket status ─────────────────────────────
router.patch('/staff/tickets/:ticketId', authMiddleware, async (req, res) => {
  try {
    const { status, counter_id } = req.body;
    const allowed = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const extra = status === 'completed' ? ', completed_at = NOW()' : '';
    await executeQuery(
      `UPDATE qms_tickets SET status = ?, counter_id = COALESCE(?, counter_id) ${extra} WHERE id = ?`,
      [status, counter_id, req.params.ticketId]
    );

    const ticket = await executeQuery(
      `SELECT t.*, s.name AS service_name, s.prefix, s.color
       FROM qms_tickets t
       JOIN qms_service_types s ON s.id = t.service_type_id
       WHERE t.id = ?`,
      [req.params.ticketId]
    );

    res.json({ success: true, data: ticket[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Staff: recall ticket ────────────────────────────────────
router.post('/staff/tickets/:ticketId/recall', authMiddleware, async (req, res) => {
  try {
    await executeQuery(
      `UPDATE qms_tickets SET status = 'called', called_at = NOW() WHERE id = ?`,
      [req.params.ticketId]
    );
    const ticket = await executeQuery(
      `SELECT t.*, s.name AS service_name, s.prefix, s.color, c.name AS counter_name
       FROM qms_tickets t
       JOIN qms_service_types s ON s.id = t.service_type_id
       LEFT JOIN qms_counters c ON c.id = t.counter_id
       WHERE t.id = ?`,
      [req.params.ticketId]
    );
    res.json({ success: true, data: ticket[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Stats for admin dashboard ───────────────────────────────
router.get('/stats/:branchId', authMiddleware, async (req, res) => {
  try {
    const dateKey = todayKey();
    const stats = await executeQuery(
      `SELECT
         COUNT(*) AS total_today,
         SUM(status = 'waiting') AS waiting,
         SUM(status IN ('called','serving')) AS in_progress,
         SUM(status = 'completed') AS completed,
         SUM(status = 'skipped') AS skipped
       FROM qms_tickets
       WHERE branch_id = ? AND date_key = ?`,
      [req.params.branchId, dateKey]
    );

    const byService = await executeQuery(
      `SELECT s.name, s.prefix, s.color, COUNT(t.id) AS count
       FROM qms_service_types s
       LEFT JOIN qms_tickets t ON t.service_type_id = s.id AND t.date_key = ?
       WHERE s.branch_id = ?
       GROUP BY s.id ORDER BY s.display_order`,
      [dateKey, req.params.branchId]
    );

    res.json({ success: true, data: { summary: stats[0], by_service: byService } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
