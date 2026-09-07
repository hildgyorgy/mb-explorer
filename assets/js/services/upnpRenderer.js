const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

let renderer = null;
const BRIDGE_URL = "http://localhost:9181";

function localName(tag) {
  return String(tag || "").split("}").pop();
}

async function xml(url) {
  const response = await fetch(url, { headers: { Accept: "application/xml, text/xml" } });
  if (!response.ok) throw new Error(`Renderer description returned HTTP ${response.status}.`);
  return new DOMParser().parseFromString(await response.text(), "application/xml");
}

export async function loadRendererDescription(descriptionUrl) {
  const raw = String(descriptionUrl || "").trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error("Enter the complete HTTP(S) device description URL.");
  const url = new URL(raw);
  const document = await xml(url);
  const services = [...document.getElementsByTagNameNS("*", "service")]
    .map((service) => {
      const values = {};
      [...service.children].forEach((child) => { values[localName(child.tagName)] = child.textContent || ""; });
      return values;
    })
    .filter((service) => service.serviceType?.includes("schemas-upnp-org:service:AVTransport:"))
    .sort((a, b) => Number(b.serviceType.split(":").pop()) - Number(a.serviceType.split(":").pop()));
  if (!services.length || !services[0].controlURL) throw new Error("The renderer has no AVTransport service.");
  const friendlyName = document.getElementsByTagNameNS("*", "friendlyName")[0]?.textContent || "UPnP renderer";
  const service = services[0];
  renderer = { friendlyName, serviceType: service.serviceType, controlUrl: new URL(service.controlURL, url).toString() };
  return renderer;
}

export async function loadBridgeRenderer(bridgeUrl = BRIDGE_URL) {
  const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/renderers`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`UPnP bridge returned HTTP ${response.status}.`);
  const payload = await response.json();
  const found = payload.renderers?.[0];
  if (!found) throw new Error("The bridge found no UPnP renderer.");
  renderer = { ...found, mode: "bridge", bridgeUrl: bridgeUrl.replace(/\/$/, "") };
  return renderer;
}

function value(document, name) {
  return [...document.getElementsByTagNameNS("*", name)][0]?.textContent || "";
}

export async function callRenderer(action, argumentsList = []) {
  if (!renderer) throw new Error("No UPnP renderer is connected.");
  if (renderer.mode === "bridge") {
    const actions = { Play: "play", Pause: "pause", Stop: "stop", Next: "next", Previous: "previous" };
    const bridgeAction = actions[action];
    if (!bridgeAction) throw new Error(`${action} is not supported by the bridge yet.`);
    const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/${bridgeAction}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error(`${action} returned HTTP ${response.status}.`);
    return response.json();
  }
  const document = documentFromString(`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${SOAP_NS}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${renderer.serviceType}"></u:${action}></s:Body></s:Envelope>`);
  const actionNode = document.getElementsByTagNameNS(renderer.serviceType, action)[0];
  argumentsList.forEach(([name, argument]) => {
    const node = document.createElementNS(renderer.serviceType, name);
    node.textContent = String(argument ?? "");
    actionNode.appendChild(node);
  });
  const response = await fetch(renderer.controlUrl, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${renderer.serviceType}#${action}"` },
    body: new XMLSerializer().serializeToString(document),
  });
  if (!response.ok) throw new Error(`${action} returned HTTP ${response.status}.`);
  return new DOMParser().parseFromString(await response.text(), "application/xml");
}

function documentFromString(source) {
  return new DOMParser().parseFromString(source, "application/xml");
}

function escapeXml(value) {
  return String(value || "").replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[character]));
}

export function didlMetadata({ id, title, artist, album, mime = "audio/flac", duration = "" }, uri) {
  return `<?xml version="1.0" encoding="UTF-8"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="${escapeXml(id)}" parentID="0" restricted="1"><dc:title>${escapeXml(title)}</dc:title><upnp:artist>${escapeXml(artist)}</upnp:artist><upnp:album>${escapeXml(album)}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:${escapeXml(mime)}:*"${duration ? ` duration="${escapeXml(duration)}"` : ""}>${escapeXml(uri)}</res></item></DIDL-Lite>`;
}

export async function setCurrentAndNext(current, next, items = null) {
  if (renderer?.mode === "bridge") {
    const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/queue`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, next, ...(items ? { items } : {}) }),
    });
    if (!response.ok) throw new Error(`Queue returned HTTP ${response.status}.`);
    return response.json();
  }
  await callRenderer("SetAVTransportURI", [["InstanceID", 0], ["CurrentURI", current.uri], ["CurrentURIMetaData", current.metadata || ""]]);
  if (next) await callRenderer("SetNextAVTransportURI", [["InstanceID", 0], ["NextURI", next.uri], ["NextURIMetaData", next.metadata || ""]]);
}

export async function setNext(next) {
  if (renderer?.mode === "bridge") {
    const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/nexturi`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next }),
    });
    if (!response.ok) throw new Error(`Next queue returned HTTP ${response.status}.`);
    return response.json();
  }
  await callRenderer("SetNextAVTransportURI", [["InstanceID", 0], ["NextURI", next.uri], ["NextURIMetaData", next.metadata || ""]]);
}

export async function playRenderer() {
  await callRenderer("Play", [["InstanceID", 0], ["Speed", "1"]]);
}

export async function getRendererState() {
  if (!renderer) throw new Error("No UPnP renderer is connected.");
  if (renderer.mode !== "bridge") return null;
  const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/state`);
  if (!response.ok) throw new Error(`Renderer state returned HTTP ${response.status}.`);
  return response.json();
}

export function getRenderer() { return renderer; }

export function disconnectRenderer() { renderer = null; }
