#!/usr/bin/env python3
"""Minimal local UPnP AVTransport bridge for MusiCards."""

import json
import os
import socket
import threading
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/"
AVT_PREFIX = "urn:schemas-upnp-org:service:AVTransport:"
PORT = int(os.environ.get("MUSICARDS_BRIDGE_PORT", "9181"))


def xml_value(node, name):
    return next((x.text or "" for x in node.iter()
                 if x.tag.rsplit("}", 1)[-1] == name), "")


def discover():
    message = ("M-SEARCH * HTTP/1.1\r\n"
               "HOST: 239.255.255.250:1900\r\n"
               'MAN: "ssdp:discover"\r\nMX: 1\r\n'
               "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(1.5)
    found = {}
    try:
        sock.sendto(message.encode(), ("239.255.255.250", 1900))
        while True:
            try:
                data, address = sock.recvfrom(65535)
            except socket.timeout:
                break
            headers = {}
            for line in data.decode("utf-8", "replace").split("\r\n"):
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.lower()] = value.strip()
            location = headers.get("location")
            if location:
                found[location] = {"location": location, "address": address[0]}
    finally:
        sock.close()
    return list(found.values())


def renderer_from_description(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        root = ET.fromstring(response.read())
    services = []
    for service in root.iter():
        if service.tag.rsplit("}", 1)[-1] != "service":
            continue
        service_type = xml_value(service, "serviceType")
        control = xml_value(service, "controlURL")
        if service_type.startswith(AVT_PREFIX) and control:
            services.append((service_type, urllib.parse.urljoin(url, control)))
    if not services:
        raise RuntimeError("AVTransport service not found")
    service_type, control_url = max(services, key=lambda x: x[0].rsplit(":", 1)[-1])
    return {"id": url, "descriptionUrl": url,
            "friendlyName": xml_value(root, "friendlyName") or "UPnP renderer",
            "serviceType": service_type, "controlUrl": control_url}


def soap_call(renderer, action, arguments=()):
    envelope = ET.Element(ET.QName(SOAP_NS, "Envelope"),
                         {ET.QName(SOAP_NS, "encodingStyle"):
                          "http://schemas.xmlsoap.org/soap/encoding/"})
    body = ET.SubElement(envelope, ET.QName(SOAP_NS, "Body"))
    action_node = ET.SubElement(body, ET.QName(renderer["serviceType"], action))
    for name, value in arguments:
        ET.SubElement(action_node, name).text = str(value)
    request = urllib.request.Request(
        renderer["controlUrl"], data=ET.tostring(envelope, encoding="utf-8",
        xml_declaration=True), method="POST",
        headers={"Content-Type": 'text/xml; charset="utf-8"',
                 "SOAPAction": f'"{renderer["serviceType"]}#{action}"'})
    with urllib.request.urlopen(request, timeout=15) as response:
        return ET.fromstring(response.read())


def soap_text(renderer, action, arguments=(), names=()):
    root = soap_call(renderer, action, arguments)
    values = {node.tag.rsplit("}", 1)[-1]: (node.text or "") for node in root.iter()}
    return {name: values.get(name, "") for name in names}


class BridgeState:
    def __init__(self):
        self.lock = threading.Lock()
        self.renderers = {}
        self.queue = {}
        self.last_next = {}
        self.last_current = {}

    def refresh(self):
        with self.lock:
            for item in discover():
                try:
                    renderer = renderer_from_description(item["location"])
                    self.renderers[renderer["id"]] = renderer
                except Exception:
                    continue
            return list(self.renderers.values())

    def get(self, renderer_id):
        with self.lock:
            renderer = self.renderers.get(renderer_id)
        if not renderer:
            self.refresh()
            renderer = self.renderers.get(renderer_id)
        if not renderer:
            raise KeyError("renderer not found")
        return renderer


STATE = BridgeState()


def queue_watcher():
    while True:
        threading.Event().wait(1)
        with STATE.lock:
            queues = list(STATE.queue.items())
            renderers = dict(STATE.renderers)
        for renderer_id, items in queues:
            renderer = renderers.get(renderer_id)
            if not renderer or not items:
                continue
            try:
                current = soap_text(renderer, "GetMediaInfo", [("InstanceID", 0)], ("CurrentURI",)).get("CurrentURI", "")
                index = next((i for i, item in enumerate(items) if item.get("uri") == current), -1)
                if index < 0 or index + 1 >= len(items):
                    continue
                changed = bool(STATE.last_current.get(renderer_id)) and STATE.last_current.get(renderer_id) != current
                next_item = items[index + 1]
                if STATE.last_next.get(renderer_id) == next_item.get("uri"):
                    continue
                soap_call(renderer, "SetNextAVTransportURI", [("InstanceID", 0),
                    ("NextURI", next_item["uri"]),
                    ("NextURIMetaData", next_item.get("metadata", ""))])
                STATE.last_next[renderer_id] = next_item.get("uri")
                STATE.last_current[renderer_id] = current
                if changed:
                    state = soap_text(renderer, "GetTransportInfo", [("InstanceID", 0)], ("CurrentTransportState",)).get("CurrentTransportState", "")
                    if state == "STOPPED":
                        soap_call(renderer, "Play", [("InstanceID", 0), ("Speed", 1)])
            except Exception:
                continue


threading.Thread(target=queue_watcher, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        try:
            if self.path == "/health":
                return self.send_json(200, {"ok": True})
            if self.path == "/renderers":
                return self.send_json(200, {"renderers": STATE.refresh()})
            parts = urllib.parse.urlsplit(self.path).path.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "renderers" and parts[2] == "state":
                renderer = STATE.get(urllib.parse.unquote(parts[1]))
                transport = soap_text(renderer, "GetTransportInfo", [("InstanceID", 0)], ("CurrentTransportState", "CurrentTransportStatus"))
                position = soap_text(renderer, "GetPositionInfo", [("InstanceID", 0)], ("TrackDuration", "RelTime", "Track"))
                media = soap_text(renderer, "GetMediaInfo", [("InstanceID", 0)], ("CurrentURI",))
                return self.send_json(200, {**transport, **position, **media})
            return self.send_json(404, {"error": "not found"})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_POST(self):
        try:
            parts = urllib.parse.urlsplit(self.path).path.strip("/").split("/")
            if len(parts) < 2 or parts[0] != "renderers":
                return self.send_json(404, {"error": "not found"})
            renderer = STATE.get(urllib.parse.unquote(parts[1]))
            body = self.read_json()
            action = parts[2] if len(parts) > 2 else ""
            if action == "queue":
                items = body.get("items") or [body["current"]] + ([body["next"]] if body.get("next") else [])
                current = items[0]
                next_uri = items[1] if len(items) > 1 else None
                soap_call(renderer, "SetAVTransportURI", [("InstanceID", 0),
                    ("CurrentURI", current["uri"]),
                    ("CurrentURIMetaData", current.get("metadata", ""))])
                if next_uri:
                    soap_call(renderer, "SetNextAVTransportURI", [("InstanceID", 0),
                        ("NextURI", next_uri["uri"]),
                        ("NextURIMetaData", next_uri.get("metadata", ""))])
                with STATE.lock:
                    STATE.queue[renderer["id"]] = items
                    STATE.last_next[renderer["id"]] = next_uri.get("uri") if next_uri else None
                return self.send_json(200, {"ok": True})
            if action == "nexturi":
                item = body["next"]
                soap_call(renderer, "SetNextAVTransportURI", [("InstanceID", 0),
                    ("NextURI", item["uri"]),
                    ("NextURIMetaData", item.get("metadata", ""))])
                return self.send_json(200, {"ok": True})
            if action == "seek":
                seconds = max(0, int(body.get("seconds", 0)))
                target = f"0:{seconds // 60:02d}:{seconds % 60:02d}"
                soap_call(renderer, "Seek", [("InstanceID", 0), ("Unit", "REL_TIME"), ("Target", target)])
                return self.send_json(200, {"ok": True})
            if action in {"play", "pause", "stop", "next", "previous"}:
                names = {"play": ("Play", [("Speed", 1)]),
                         "pause": ("Pause", []), "stop": ("Stop", []),
                         "next": ("Next", [("Unit", "TRACK")]),
                         "previous": ("Previous", [("Unit", "TRACK")])}
                name, args = names[action]
                soap_call(renderer, name, [("InstanceID", 0)] + args)
                return self.send_json(200, {"ok": True})
            return self.send_json(404, {"error": "unknown action"})
        except KeyError as error:
            self.send_json(404, {"error": str(error)})
        except Exception as error:
            self.send_json(502, {"error": str(error)})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"MusiCards UPnP bridge listening on http://0.0.0.0:{PORT}")
    server.serve_forever()
