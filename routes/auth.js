const express = require('express');
const bcrypt = require('bcrypt');
const { executeQuery } = require('../config/database');
const { signToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const users = await executeQuery(
      'SELECT * FROM qms_users WHERE email = ? AND is_active = 1 LIMIT 1',
      [email.toLowerCase().trim()]
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
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        org_id: user.org_id,
        branch_id: user.branch_id,
      },
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

module.exports = router;
