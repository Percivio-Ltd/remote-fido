chrome.action.onClicked.addListener(() => chrome.tabs.create({url: chrome.runtime.getURL('app.html')}));
chrome.alarms.create('pending', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(async () => {
  const {config} = await chrome.storage.local.get('config');
  if (!config) return;
  try {
    const response = await fetch(`${config.coordinator}/status`, {headers: {Authorization: `Bearer ${config.token}`}, signal: AbortSignal.timeout(5000), redirect: 'error'});
    if (!response.ok) throw new Error('Unavailable');
    const state = await response.json();
    const count = state.requests.filter(r => !r.approver && (state.mode === 'any' || state.selected === config.id)).length;
    await chrome.action.setBadgeText({text: count ? String(count) : ''});
  } catch { await chrome.action.setBadgeText({text: '?'}); }
});
