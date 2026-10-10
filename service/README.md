# grape-engine

The Python OCR service used by the [Grape](../README.md) GNOME extension. It runs
RapidOCR outside GNOME Shell and exposes it over the session D-Bus, so the Shell
never does inference itself and nothing runs at login.

- **Engine**: `rapidocr` + `onnxruntime` (CPU only).
- **IPC**: `dbus-fast` over the session bus, started by D-Bus activation.
- **Install**: from a checkout `pipx install ./service`, then
  `grape-engine install-models && grape-engine install-dbus`. Once published to
  PyPI the first command becomes `pipx install grape-engine`.
- **Docs**: see [`docs/DBUS-API.md`](../docs/DBUS-API.md) for the bus interface and
  [`docs/INSTALL.md`](../docs/INSTALL.md) for the full user guide.
