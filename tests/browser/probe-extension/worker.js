globalThis.runProbe = async (tabId, world, options) => {
  return chrome.scripting.executeScript({
    target: {tabId}, world,
    func: async options => {
      try {
        const credential = await navigator.credentials.get({
          publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options)
        });
        return {ok: true, response: credential.toJSON()};
      } catch (error) {
        return {ok: false, name: error.name, message: error.message};
      }
    },
    args: [options]
  });
};
