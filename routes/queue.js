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

async function getActiveServices(branchId) {
  return executeQuery(
    `SELECT id, name, prefix, color, display_order
     FROM qms_service_types
     WHERE branch_id = ? AND is_active = 1
     ORDER BY display_order, id`,
    [branchId]
  );
}

/**
 * One shared daily counter for the whole branch (Consultation + Grooming).
 * Stored on the primary/consultation service_type row so Number Settings stays one place.
 */
async function allocateSharedTicketNumber(conn, branchId, dateKey) {
  const sequenceOwner = await getConsultationService(branchId);
  if (!sequenceOwner) {
    throw new Error('No shared queue sequence configured for this branch');
  }

  await conn.execute(
    `INSERT INTO qms_daily_sequences (branch_id, service_type_id, date_key, last_number)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
    [branchId, sequenceOwner.id, dateKey]
  );

  const [seqRows] = await conn.execute(
    'SELECT last_number FROM qms_daily_sequences WHERE branch_id = ? AND service_type_id = ? AND date_key = ?',
    [branchId, sequenceOwner.id, dateKey]
  );

  return {
    ticketNumber: Number(seqRows[0].last_number),
    sequenceOwnerId: sequenceOwner.id,
  };
}

/** OPD 1 → OPD1; Grooming / other names keep their display name for TV + voice */
function formatCounterLabel(counterName, index = 0) {
  const name = String(counterName || '').trim();
  const opdMatch = name.match(/opd\s*(\d+)/i);
  if (opdMatch) return `OPD${opdMatch[1]}`;
  if (name) return name;
  return `OPD${index + 1}`;
}

function deriveStation(counterName, index = 0) {
  const opdMatch = String(counterName || '').match(/opd\s*(\d+)/i);
  if (opdMatch) return parseInt(opdMatch[1], 10);
  return index + 1;
}

function attachCounterLabel(payload) {
  if (!payload) return payload;
  if (payload.counter_name) {
    payload.counter_label = formatCounterLabel(payload.counter_name);
  }
  return payload;
}

async function getActiveCounters(branchId) {
  return executeQuery(
    `SELECT c.id, c.name, c.service_type_id, s.name AS service_name, s.prefix AS service_prefix, s.color AS service_color
     FROM qms_counters c
     LEFT JOIN qms_service_types s ON s.id = c.service_type_id
     WHERE c.branch_id = ? AND c.is_active = 1
     ORDER BY c.id ASC`,
    [branchId]
  );
}

async function getServingByCounter(branchId, dateKey) {
  const counters = await getActiveCounters(branchId);

  const serving = await executeQuery(
    `SELECT t.id, t.counter_id, t.ticket_code, t.status, t.called_at,
            s.name AS service_name, s.color
     FROM qms_tickets t
     JOIN qms_service_types s ON s.id = t.service_type_id
     WHERE t.branch_id = ? AND t.date_key = ?
       AND t.status IN ('called', 'serving')
       AND t.counter_id IS NOT NULL
     ORDER BY t.called_at DESC`,
    [branchId, dateKey]
  );

  const latestByCounter = new Map();
  for (const ticket of serving) {
    if (!latestByCounter.has(ticket.counter_id)) {
      latestByCounter.set(ticket.counter_id, ticket);
    }
  }

  return counters.map((counter, index) => {
    const active = latestByCounter.get(counter.id);
    return {
      counter_id: counter.id,
      counter_name: counter.name,
      service_type_id: counter.service_type_id || null,
      station: deriveStation(counter.name, index),
      counter_label: formatCounterLabel(counter.name, index),
      ticket_code: active?.ticket_code || null,
      ticket_id: active?.id || null,
      status: active?.status || null,
      service_name: active?.service_name || counter.service_name || null,
      color: active?.color || counter.service_color || null,
      called_at: active?.called_at || null,
    };
  });
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

// ── Simple token: plain number from shared branch sequence ──
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

    const { ticketNumber } = await allocateSharedTicketNumber(conn, branch.id, dateKey);
    const ticketCode = String(ticketNumber);

    const [insertResult] = await conn.execute(
      `INSERT INTO qms_tickets
        (branch_id, service_type_id, ticket_number, ticket_code, date_key)
       VALUES (?, ?, ?, ?, ?)`,
      [branch.id, service.id, ticketNumber, ticketCode, dateKey]
    );

    await conn.commit();

    const waitingRows = await executeQuery(
      `SELECT COUNT(*) AS cnt
       FROM qms_tickets
       WHERE branch_id = ? AND service_type_id = ? AND date_key = ?
         AND status = 'waiting' AND id <> ?`,
      [branch.id, service.id, dateKey, insertResult.insertId]
    );

    res.status(201).json({
      success: true,
      data: {
        id: insertResult.insertId,
        ticket_code: ticketCode,
        ticket_number: ticketNumber,
        branch_name: branch.name,
        service_name: service.name,
        waiting_ahead: Number(waitingRows[0]?.cnt || 0),
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

    const services = await getActiveServices(branch.id);

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

// ── Issue a new ticket (shared number sequence for all categories) ──
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

    // Same counter as Consultation Number Settings (28, 29, 30…) for every category
    const { ticketNumber } = await allocateSharedTicketNumber(conn, branch.id, dateKey);
    const ticketCode = String(ticketNumber);

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

// ── Public: OPD counters for branch (tablets + display) ─────
router.get('/public/:orgSlug/:branchSlug/counters', async (req, res) => {
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const counters = await getActiveCounters(branch.id);
    const byCounter = await getServingByCounter(branch.id, todayKey());

    res.json({
      success: true,
      data: counters.map((c, index) => {
        const match = byCounter.find((row) => row.counter_id === c.id);
        return {
          id: c.id,
          name: c.name,
          service_type_id: c.service_type_id || null,
          service_name: c.service_name || null,
          station: match?.station || deriveStation(c.name, index),
          counter_label: match?.counter_label || formatCounterLabel(c.name, index),
          now_serving: match?.ticket_code || null,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Free spoken announcements for Smart TV displays (no browser TTS required).
// Proxies Google Translate TTS so the TV plays normal MP3 audio same-origin.
router.get('/public/announce-tts', async (req, res) => {
  try {
    const text = String(req.query.text || '').trim().slice(0, 160);
    if (!text) {
      return res.status(400).json({ success: false, message: 'text is required' });
    }

    const encoded = encodeURIComponent(text);
    const providers = [
      `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encoded}`,
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encoded}`,
    ];

    let buffer = null;
    for (const url of providers) {
      try {
        const upstream = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
          },
        });
        if (!upstream.ok) continue;
        const contentType = String(upstream.headers.get('content-type') || '');
        if (contentType.includes('json') || contentType.includes('text/html')) continue;
        const data = Buffer.from(await upstream.arrayBuffer());
        if (data.length < 200) continue;
        buffer = data;
        break;
      } catch (_) {
        /* try next provider */
      }
    }

    if (!buffer) {
      return res.status(502).json({
        success: false,
        message: 'Speech audio provider unavailable',
      });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
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

    const byCounter = await getServingByCounter(branch.id, dateKey);

    res.json({
      success: true,
      data: {
        branch: { name: branch.name, org_name: branch.org_name },
        date_key: dateKey,
        now_serving: nowServing,
        by_counter: byCounter,
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

    const { counter_id, service_type_id } = req.body;
    const counters = await getActiveCounters(branch.id);
    if (counters.length && !counter_id) {
      return res.status(400).json({ success: false, message: 'Please select a station (OPD / Grooming) before calling the next patient' });
    }

    let selectedCounter = null;
    if (counter_id) {
      selectedCounter = counters.find((c) => String(c.id) === String(counter_id));
      if (!selectedCounter) {
        return res.status(400).json({ success: false, message: 'Invalid station for this branch' });
      }
    }

    // Call from the counter's queue (Grooming desk → grooming tickets; OPD → consultation)
    let serviceTypeId = service_type_id || selectedCounter?.service_type_id || null;
    if (!serviceTypeId) {
      const consultation = await getConsultationService(branch.id);
      serviceTypeId = consultation?.id || null;
    }
    if (!serviceTypeId) {
      return res.status(400).json({ success: false, message: 'No queue service configured for this station' });
    }

    const dateKey = todayKey();

    await conn.beginTransaction();

    let query = `
      SELECT t.id FROM qms_tickets t
      WHERE t.branch_id = ? AND t.date_key = ? AND t.status = 'waiting'
        AND t.service_type_id = ?
      ORDER BY t.ticket_number ASC LIMIT 1 FOR UPDATE
    `;
    const params = [branch.id, dateKey, serviceTypeId];

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
    res.json({ success: true, data: attachCounterLabel(ticket[0]) });
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
    res.json({ success: true, data: attachCounterLabel(ticket[0]) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/public/:orgSlug/:branchSlug/queue', async (req, res) => {
  try {
    const branch = await getBranchBySlug(req.params.orgSlug, req.params.branchSlug);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const dateKey = todayKey();
    let query = `
      SELECT t.*, s.name AS service_name, s.prefix, s.color, c.name AS counter_name
      FROM qms_tickets t
      JOIN qms_service_types s ON s.id = t.service_type_id
      LEFT JOIN qms_counters c ON c.id = t.counter_id
      WHERE t.branch_id = ? AND t.date_key = ? AND t.status IN ('waiting','called','serving')
    `;
    const params = [branch.id, dateKey];

    if (req.query.service_type_id) {
      query += ' AND t.service_type_id = ?';
      params.push(req.query.service_type_id);
    }

    query += ' ORDER BY t.ticket_number ASC';

    const tickets = await executeQuery(query, params);
    res.json({
      success: true,
      data: tickets.map((t) => attachCounterLabel({ ...t })),
    });
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
