/**
 * Shared screen unlock helpers for counter / kiosk HTML pages.
 */
(function (global) {
  function unlockKey(screen, orgSlug, branchSlug) {
    return 'qms-unlock-' + screen + '-' + orgSlug + '-' + branchSlug;
  }

  function isUnlocked(screen, orgSlug, branchSlug) {
    try {
      return sessionStorage.getItem(unlockKey(screen, orgSlug, branchSlug)) === '1';
    } catch (_) {
      return false;
    }
  }

  function markUnlocked(screen, orgSlug, branchSlug) {
    try {
      sessionStorage.setItem(unlockKey(screen, orgSlug, branchSlug), '1');
    } catch (_) { /* ignore */ }
  }

  /**
   * If PIN required and not unlocked, show overlay and resolve when unlocked.
   * @returns {Promise<void>}
   */
  async function requireScreenUnlock(screen, orgSlug, branchSlug) {
    const title = screen === 'kiosk' ? 'Take a Ticket' : 'OPD / Counter';
    let required = false;
    try {
      const res = await fetch(`/api/queue/public/${orgSlug}/${branchSlug}/screen-lock`);
      const json = await res.json();
      if (json.success) {
        required = screen === 'kiosk' ? !!json.data.kiosk_required : !!json.data.counter_required;
      }
    } catch (_) {
      required = false;
    }

    if (!required || isUnlocked(screen, orgSlug, branchSlug)) return;

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'screenLockOverlay';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.92);display:flex;' +
        'align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif;';
      overlay.innerHTML =
        '<div style="width:100%;max-width:380px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 20px 50px rgba(0,0,0,.35);">' +
          '<div style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#0d9488;margin-bottom:6px;">PetZone Hospital</div>' +
          '<h2 style="margin:0 0 8px;font-size:22px;color:#0f172a;">' + title + ' Locked</h2>' +
          '<p style="margin:0 0 18px;color:#64748b;font-size:14px;line-height:1.4;">Enter the password set in Admin → Branches.</p>' +
          '<label style="display:block;font-size:13px;font-weight:600;color:#334155;margin-bottom:6px;">Password</label>' +
          '<input id="screenLockPin" type="password" autocomplete="current-password" ' +
            'style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:16px;margin-bottom:10px;" />' +
          '<div id="screenLockError" style="display:none;color:#b91c1c;font-size:13px;margin-bottom:10px;"></div>' +
          '<button id="screenLockBtn" type="button" ' +
            'style="width:100%;padding:12px;border:0;border-radius:10px;background:#1e3a8a;color:#fff;font-weight:700;font-size:15px;cursor:pointer;">Unlock</button>' +
        '</div>';
      document.body.appendChild(overlay);

      const input = overlay.querySelector('#screenLockPin');
      const err = overlay.querySelector('#screenLockError');
      const btn = overlay.querySelector('#screenLockBtn');

      async function tryUnlock() {
        const pin = (input.value || '').trim();
        if (!pin) {
          err.style.display = 'block';
          err.textContent = 'Enter password';
          return;
        }
        btn.disabled = true;
        try {
          const res = await fetch(`/api/queue/public/${orgSlug}/${branchSlug}/screen-unlock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen: screen, pin: pin }),
          });
          const json = await res.json();
          if (!json.success) throw new Error(json.message || 'Incorrect password');
          markUnlocked(screen, orgSlug, branchSlug);
          overlay.remove();
          resolve();
        } catch (e) {
          err.style.display = 'block';
          err.textContent = e.message || 'Incorrect password';
          input.select();
        } finally {
          btn.disabled = false;
        }
      }

      btn.addEventListener('click', tryUnlock);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') tryUnlock();
      });
      setTimeout(() => input.focus(), 50);
    });
  }

  global.QmsScreenLock = { requireScreenUnlock: requireScreenUnlock, isUnlocked: isUnlocked };
})(window);
