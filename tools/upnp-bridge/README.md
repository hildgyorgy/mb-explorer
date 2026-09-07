# MusiCards UPnP bridge

Kis, függőségmentes helyi szolgáltatás a MusiCards webapp és a UPnP MediaRenderer
között. A bridge csak SSDP-felderítést és AVTransport SOAP-parancsokat végez;
hangadatot nem továbbít.

## Futtatás

```sh
python3 musicards_upnp_bridge.py
```

Dockerből Umbrel/ARM gépen a konténernek host hálózatot kell kapnia, hogy az
SSDP multicast működjön. A webes API alapértelmezett portja: `9181`.

Ez az első verzió szándékosan csak a vezérlési alapot tartalmazza. A MusiCards
integrációja a `/renderers`, `/queue` és `/play` végpontokra fog épülni.
