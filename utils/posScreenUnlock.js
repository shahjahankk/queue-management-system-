const crypto = require('crypto');

function ssoSecret() {
  return (
    process.env.SSO_SHARED_SECRET ||
    process.env.QMS_SSO_SECRET ||
    'petzone-qms-sso-shared-secret'
  );
}

function mintPosScreenUnlockToken({ screen, orgSlug, branchSlug, ttlMs = 2 * 60 * 1000 }) {
  const payload = {
    screen: String(screen || '').toLowerCase(),
    orgSlug: String(orgSlug || ''),
    branchSlug: String(branchSlug || ''),
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', ssoSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyPosScreenUnlockToken(token, { screen, orgSlug, branchSlug }) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, message: 'Invalid unlock token' };
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', ssoSecret()).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, message: 'Invalid unlock token' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, message: 'Invalid unlock token' };
  }
  if (!payload?.exp || Number(payload.exp) < Date.now()) {
    return { ok: false, message: 'Unlock token expired' };
  }
  if (String(payload.screen).toLowerCase() !== String(screen).toLowerCase()) {
    return { ok: false, message: 'Unlock token screen mismatch' };
  }
  if (payload.orgSlug !== orgSlug || payload.branchSlug !== branchSlug) {
    return { ok: false, message: 'Unlock token branch mismatch' };
  }
  return { ok: true, payload };
}

module.exports = {
  ssoSecret,
  mintPosScreenUnlockToken,
  verifyPosScreenUnlockToken,
};
