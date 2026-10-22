// Only inspect our two known proxy extensions; never enable/disable extensions.
export const TARGET_ID = 'dollgdpmepjkbpialkfeafneeppmcijn';
export const LEGACY_ID = 'agnmnnemjpbpgjambapffefalbmengaf';
export async function acquireForwardingGuard(api = chrome) {
  // getAll avoids treating a permissions/API failure as "not installed".
  if (!api.management?.getAll) throw new Error('Reload the approver and accept its extension-inspection permission before approving.');
  const installed = await api.management.getAll();
  if (installed.some(x => x.id === LEGACY_ID && x.enabled))
    throw new Error('Disable the legacy LYTiQ Remote FIDO extension in this approver profile; it cannot suspend forwarding safely.');
  if (!installed.some(x => x.id === TARGET_ID && x.enabled)) {
    let safe = true, resolveLost;
    const lost = new Promise(resolve => { resolveLost = resolve; });
    const changed = x => { if ([TARGET_ID, LEGACY_ID].includes(x.id) && x.enabled) { safe = false; resolveLost(); } };
    api.management.onEnabled.addListener(changed); api.management.onInstalled.addListener(changed);
    // Close the snapshot/listener race before allowing local signing.
    try { (await api.management.getAll()).forEach(changed); }
    catch (e) { api.management.onEnabled.removeListener(changed); api.management.onInstalled.removeListener(changed); throw e; }
    if (!safe) { api.management.onEnabled.removeListener(changed); api.management.onInstalled.removeListener(changed); throw new Error('A forwarding extension changed; start a new login.'); }
    return {lost, assertHeld() { if (!safe) throw new Error('A forwarding extension was enabled during approval; start a new login.'); },
      release() { safe = false; api.management.onEnabled.removeListener(changed); api.management.onInstalled.removeListener(changed); }};
  }
  const port = api.runtime.connect(TARGET_ID, {name: 'remote-fido-local-approval-v1'});
  let held = false, released = false, rejectReady, resolveLost, pulse;
  const lost = new Promise(resolve => { resolveLost = resolve; });
  const changed = x => { if (x.id === LEGACY_ID && x.enabled) { held = false; resolveLost(); rejectReady?.(new Error('Legacy forwarding was enabled during approval')); } };
  api.management.onEnabled.addListener(changed); api.management.onInstalled.addListener(changed);
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    port.onMessage.addListener(m => {
      if (m?.type === 'suspended' && m.protocol === 1) { held = true; resolve(); }
      else if (m?.type === 'refused') reject(new Error(m.error || 'Could not suspend local forwarding'));
    });
    port.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      held = false;
      if (!released) { reject(new Error('Local forwarding guard disconnected; reload both Remote FIDO extensions.')); resolveLost(); }
    });
  });
  const timer = setTimeout(() => rejectReady(new Error('Local target did not confirm suspension. Reload both Remote FIDO extensions.')), 5000);
  const release = () => { if (!released) { released = true; held = false; clearInterval(pulse); api.management.onEnabled.removeListener(changed); api.management.onInstalled.removeListener(changed); port.disconnect(); } };
  try { await ready; } catch (e) { release(); throw e; } finally { clearTimeout(timer); }
  // MV3 ports alone do not keep a worker alive. Traffic keeps the guard alive
  // while the user selects a key / enters its PIN; it never retries signing.
  pulse = setInterval(() => { try { port.postMessage({type: 'pulse'}); } catch { held = false; resolveLost(); } }, 10000);
  return {release, lost, assertHeld() { if (!held) throw new Error('Local forwarding guard lost; start a new login.'); }};
}
