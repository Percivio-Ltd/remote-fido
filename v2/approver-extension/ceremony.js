// This function is serialized into an ISOLATED content world. Do not capture
// extension secrets or send them to this page. Never execute it in MAIN.
export async function ceremony(request) {
  const key = '__remoteFidoApprovalV2';
  if (location.origin !== request.origin || location.href !== request.page || window !== top)
    return {error: 'Approval document changed'};
  if (globalThis[key]) return {error: 'Another local ceremony is active'};
  const controller = new AbortController();
  globalThis[key] = {id: request.id, controller};
  const timeout = setTimeout(() => controller.abort(), Math.max(0, request.expires - Date.now()));
  const unload = () => controller.abort(); addEventListener('pagehide', unload, {once: true});
  let panel;
  try {
    // A click in the real origin supplies explicit intent (also useful on iOS).
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#101b2c;color:white;display:grid;place-items:center;font:18px system-ui';
    const root = panel.attachShadow({mode: 'closed'});
    const box = document.createElement('section'); box.style.cssText = 'max-width:540px;padding:32px';
    const title = document.createElement('h1'); title.textContent = 'Approve remote login';
    const text = document.createElement('p'); text.textContent = `${request.targetName} is requesting a passkey for ${request.origin}. No fingerprint or private key leaves this device.`;
    const button = document.createElement('button'); button.textContent = 'Use a passkey on this device';
    button.style.cssText = 'font:inherit;padding:14px;border-radius:10px;cursor:pointer';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.style.cssText = button.style.cssText;
    box.append(title, text, button, cancel); root.append(box); document.documentElement.append(panel);
    const credential = await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {once: true});
      cancel.onclick = () => controller.abort();
      button.onclick = () => {
        button.disabled = true;
        if (location.origin !== request.origin || location.href !== request.page) { controller.abort(); return; }
        const decode = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const p = request.options;
        const publicKey = {...p, challenge: decode(p.challenge), timeout: Math.max(1, request.expires - Date.now()),
          allowCredentials: p.allowCredentials.map(c => ({...c, id: decode(c.id)}))};
        navigator.credentials.get({publicKey, signal: controller.signal}).then(resolve, reject);
      };
    });
    if (location.origin !== request.origin || location.href !== request.page || controller.signal.aborted)
      throw new Error('Approval document changed or request cancelled');
    const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const response = credential.response;
    return {result: {id: credential.id, rawId: encode(credential.rawId), type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      response: {clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData),
        signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null},
      clientExtensionResults: credential.getClientExtensionResults()}};
  } catch (e) { return {error: `${e.name}: ${e.message}`}; }
  finally { clearTimeout(timeout); removeEventListener('pagehide', unload); panel?.remove(); delete globalThis[key]; }
}
export function cancelCeremony(id) {
  const value = globalThis.__remoteFidoApprovalV2;
  if (value?.id === id) value.controller.abort();
}
