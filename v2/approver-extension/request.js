// Reconstruct local options from the exact digested browser request, not from
// a second target-supplied options object. These origins require explicit host
// permission in the manifest as well as this policy.
export const rpOrigins = {
  'https://accounts.google.com': {page: 'https://accounts.google.com/robots.txt', rpIds: ['google.com', 'accounts.google.com']}
};
export async function bindRequest(request, summary, policy = rpOrigins) {
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.raw)))].map(x => x.toString(16).padStart(2, '0')).join('');
  const raw = JSON.parse(request.raw);
  const override = raw.extensions?.remoteDesktopClientOverride;
  const allowed = policy[summary.origin];
  if (digest !== summary.digest || request.id !== summary.id || request.origin !== summary.origin ||
      request.expires !== summary.expires || override?.origin !== summary.origin ||
      override?.sameOriginWithAncestors !== true || !allowed || request.page !== allowed.page ||
      !allowed.rpIds.includes(raw.rpId) || raw.rpId !== summary.rpId ||
      Object.keys(raw.extensions ?? {}).some(k => k !== 'remoteDesktopClientOverride'))
    throw new Error('Exact request / relying-party binding mismatch');
  return {...request, options: {challenge: raw.challenge, rpId: raw.rpId,
    userVerification: raw.userVerification ?? 'preferred', allowCredentials: raw.allowCredentials ?? [],
    timeout: Math.max(1, request.expires - Date.now())}};
}
