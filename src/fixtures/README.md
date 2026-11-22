# Fixtures

What the readers get back, for the parsers' tests. Line endings are kept as
they are (`.gitattributes`).

| File | What | Where its shape comes from |
|---|---|---|
| `bluez-scan.json` | `busctl --json=short --system call org.bluez / org.freedesktop.DBus.ObjectManager GetManagedObjects` during an LE discovery: four SwitchBot devices (three Indoor/Outdoor Thermo-Hygrometers, one heard without its scan response, and a device of type `0x6d`) and one other advertiser | Captured on Ubuntu (BlueZ 5.85, systemd 259) on 2026-11-23; the adapter's address and name and the other advertiser replaced, properties not used trimmed |

The advertisements in `decode.test.ts` are the plugin author's devices, as
BlueZ gave them, and pySwitchbot's test advertisements
(tests/test_adv_parser.py), written the same way.
