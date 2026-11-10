'use strict';

(async () => {
  const { api, esc, $ } = VN;
  const me = await api('/api/auth/me');
  if (me.ok) {
    if (me.data.election) $('#electionLine').textContent = `${me.data.election.title} (${me.data.election.electionID}). BSc thesis prototype on Hyperledger Fabric 2.5.`;
    if (!me.data.adminEnabled) {
      $('#adminPw').disabled = true; $('#adminBtn').disabled = true;
      $('#adminMsg').innerHTML = '<span class="unavail">Administrator sign-in is off: DASHBOARD_ADMIN_PASSWORD is not set in dashboard/.env.</span>';
    }
    if (me.data.role === 'admin') $('#adminMsg').innerHTML = '<a href="/admin">Already signed in: open the console</a>';
  }
  $('#voterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#voterMsg').textContent = 'Checking the registry…';
    const r = await api('/api/auth/voter', { json: { voterID: $('#voterID').value } });
    if (r.ok) location.href = '/voter'; else $('#voterMsg').innerHTML = `<span style="color:var(--bad)">${esc(r.data.error || 'Sign-in failed.')}</span>`;
  });
  $('#adminForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/auth/admin', { json: { password: $('#adminPw').value } });
    if (r.ok) location.href = '/admin'; else $('#adminMsg').innerHTML = `<span style="color:var(--bad)">${esc(r.data.error || 'Sign-in failed.')}</span>`;
  });
  $('#sampleLink').addEventListener('click', async (e) => {
    e.preventDefault();
    const r = await api('/api/auth/sample-voters');
    $('#samples').innerHTML = r.ok ? `${r.data.voterIDs.map((v) => `<button type="button" class="btn" data-fill="${esc(v)}">${esc(v)}</button>`).join(' ')}<div class="dim">${esc(r.data.note)}</div>` : 'Not available.';
  });
  document.addEventListener('click', (e) => { const f = e.target.dataset && e.target.dataset.fill; if (f) $('#voterID').value = f; });
})();
