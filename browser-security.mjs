export const CHROME_SECURITY_FLOOR = '156.0.8078.47';
export function requirePatchedChrome(version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Cannot establish full Chrome version');
  const actual = version.split('.').map(Number), minimum = CHROME_SECURITY_FLOOR.split('.').map(Number);
  for (let i = 0; i < 4; i++) { if (actual[i] > minimum[i]) return; if (actual[i] < minimum[i]) throw new Error(`Chrome ${version} is below reviewed security floor ${CHROME_SECURITY_FLOOR}`); }
}
