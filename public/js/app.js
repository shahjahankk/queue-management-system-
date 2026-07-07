const API = '';

function getToken() {
  return localStorage.getItem('qms_token');
}

function setToken(token) {
  if (token) localStorage.setItem('qms_token', token);
  else localStorage.removeItem('qms_token');
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

function showAlert(el, message, type = 'error') {
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function formatTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status) {
  const labels = {
    waiting: 'Waiting',
    called: 'Called',
    serving: 'Serving',
    completed: 'Done',
    skipped: 'Skipped',
    cancelled: 'Cancelled',
  };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

function openModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});
