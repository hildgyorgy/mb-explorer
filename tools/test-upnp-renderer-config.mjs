import assert from "node:assert/strict";

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.location = { protocol: "https:" };
globalThis.CustomEvent = class CustomEvent {
  constructor(type) { this.type = type; }
};
globalThis.window = { dispatchEvent() {} };

const upnp = await import("../assets/js/services/upnpRenderer.js");

assert.equal(upnp.normalizeBridgeUrl(""), "http://127.0.0.1:9181");
assert.equal(
  upnp.normalizeBridgeUrl("umbrel.example.ts.net/"),
  "https://umbrel.example.ts.net"
);
assert.throws(
  () => upnp.normalizeBridgeUrl("http://umbrel.local:9181"),
  /HTTPS bridge address/
);

const remote = upnp.setBridgeUrl("https://umbrel.example.ts.net");
assert.equal(upnp.getBridgeUrl(), remote);
upnp.selectBridgeRenderer({ id: "uuid:avm", friendlyName: "AVM Audio" }, remote);
assert.deepEqual(upnp.getSavedRendererPreference(), {
  bridgeUrl: remote,
  id: "uuid:avm",
  friendlyName: "AVM Audio",
});
upnp.disconnectRenderer();
assert.equal(upnp.getSavedRendererPreference(), null);

console.log("UPnP bridge configuration regressions passed.");
