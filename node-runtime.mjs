// Security release floors: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
export const minimumVersions = Object.freeze(['22.23.4', '24.22.1', '26.12.1']);
export const supportedNodeRange = minimumVersions.map(version => `^${version}`).join(' || ');

export function isSupportedNodeVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return minimumVersions.some(minimum => {
    const [requiredMajor, requiredMinor, requiredPatch] = minimum.split('.').map(Number);
    return major === requiredMajor && (minor > requiredMinor || (minor === requiredMinor && patch >= requiredPatch));
  });
}

if (process.release.name !== 'node' || process.versions.bun || !isSupportedNodeVersion(process.versions.node)) {
  throw new Error(`Remote FIDO requires patched Node.js ${supportedNodeRange}; detected ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`}. Install a supported stable Node.js release and restart Remote FIDO.`);
}
