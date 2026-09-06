const $ = id => document.getElementById(id);
let state; let refreshing = false; let acting = false;
const message = text => { $('message').textContent = text; };
async function send(type, args = {}) {
  const reply = await chrome.runtime.sendMessage({type, ...args});
  if (reply?.error) throw new Error(reply.error); return reply;
}
$('origin').textContent = location.origin;
$('copy').onclick = () => navigator.clipboard.writeText(location.origin).then(() => message('Extension origin copied.'), () => message('Select and copy the extension origin above.'));
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const result = await send('mobile-status'); state = result.state;
    $('device').textContent = result.configured ? `Configured as ${result.device.name ?? result.device.id}` : 'Import this device’s configuration to begin.';
    $('select').disabled = !state; $('any').disabled = !state;
    $('cancel').hidden = !result.active;
    $('selection').textContent = state ? (state.mode === 'any' ? 'Any authorized device may claim a request.' : `Selected: ${state.selected ?? 'none'}`) : 'Not connected';
    $('requests').replaceChildren();
    if (result.connectionError) message(`Cannot connect: ${result.connectionError}. Check Tailscale, Safari website permissions and extension-origin registration.`);
    for (const r of state?.requests ?? []) {
      const div = document.createElement('div'); div.className = 'request';
      const text = document.createElement('p'); text.textContent = `${r.target} → ${r.origin}\n${Math.max(0, Math.ceil((r.expires - Date.now()) / 1000))}s remaining${r.approver ? ` · claimed by ${r.approver}` : ''}`;
      const button = document.createElement('button'); const oneOff = state.mode !== 'any' && state.selected !== result.device.id;
      button.textContent = oneOff ? 'Handle this login here once' : 'Approve this login'; button.disabled = acting || Boolean(result.active || r.approver);
      button.onclick = async () => {
        acting = true; button.disabled = true;
        try { await send('mobile-approve', {id: r.id, oneOff}); message('Use the button on the Google approval page, then Face ID or Touch ID.'); }
        catch (e) { message(e.message); } finally { acting = false; await refresh(); }
      };
      div.append(text, button); $('requests').append(div);
    }
    if (!state?.requests.length) $('requests').textContent = result.active ? `Local approval: ${result.active.phase}. Return to the Google tab, or cancel here.` : state ? 'No pending login requests.' : 'Connect this device to load pending requests.';
  } catch (e) { message(e.message); } finally { refreshing = false; }
}
$('config').onchange = async e => {
  try {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 65536) throw new Error('Configuration file is too large');
    await send('mobile-configure', {config: JSON.parse(await file.text())});
    message('Configuration saved on this device. Choose Approve here by default.'); await refresh();
  } catch (e) { message(e.message); } finally { e.target.value = ''; }
};
for (const [id, mode] of [['select', 'selected'], ['any', 'any']]) $(id).onclick = async () => {
  try { await send('mobile-select', {mode, revision: state.revision}); message('Approval routing updated.'); await refresh(); } catch (e) { message(e.message); await refresh(); }
};
$('cancel').onclick = async () => { try { await send('mobile-cancel'); message('Local approval cancelled.'); await refresh(); } catch (e) { message(e.message); } };
$('refresh').onclick = refresh;
addEventListener('pageshow', refresh); document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 2500); await refresh();
