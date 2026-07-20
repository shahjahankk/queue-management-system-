require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { connectDB } = require('./config/database');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const queueRoutes = require('./routes/queue');

const app = express();
const PORT = process.env.PORT || 4050;

connectDB().catch((err) => {
  console.error('DB connection failed:', err.message);
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean).length
    ? (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim())
    : true,
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());

const ticketLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many ticket requests, please wait' },
});
app.use('/api/queue/public/:orgSlug/:branchSlug/tickets', ticketLimiter);
app.use('/api/queue/public/:orgSlug/:branchSlug/token', ticketLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/queue', queueRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ success: true, service: 'PetZone Queue Management', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/kiosk/:orgSlug/:branchSlug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

app.get('/display/:orgSlug/:branchSlug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/counter/:orgSlug/:branchSlug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'counter.html'));
});

// OPD tablet mode (branch-specific attendant panel)
app.get('/opd/:orgSlug/:branchSlug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'counter.html'));
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`PetZone Queue Management running on port ${PORT}`);
});

module.exports = app;
