import {MobileController} from './mobile-controller.js';
const controller = new MobileController(chrome);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith('mobile-')) return false;
  controller.handle(message, sender).then(respond, e => respond({error: e.message}));
  return true;
});
