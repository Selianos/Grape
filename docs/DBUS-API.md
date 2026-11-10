# Grape — D-Bus API

The Grape extension talks to the OCR service over the **session bus**. The service
is started on demand by D-Bus activation, so nothing runs at login and the bus
restarts it after the idle timeout.

| | |
| --- | --- |
| Bus name | `io.github.Selianos.Grape1` |
| Object path | `/io/github/Selianos/Grape1` |
| Endpoint (activation file) | `~/.local/share/dbus-1/services/io.github.Selianos.Grape1.service` |
| Run command | `python -m grape_engine` |

The service exports `Introspect` (from `org.freedesktop.DBus.Introspectable`) plus
the Grape interface below.

## Interface `io.github.Selianos.Grape1`

### `Warmup () → ()`

Loads the OCR models if they are not loaded yet and returns when the engine is
ready. The extension calls this **without waiting** so the model load overlaps the
user's region selection.

- Outcome: an empty tuple once the models are loaded (immediately if they
  already were). The extension never waits for it.
- Error: `...Error.ModelMissing` when the install-time models are absent.

### `Recognize (s path, a{sv} options) → (sa{sv})`

OCRs one image file and returns **one unnamed struct** holding the recognised
text and its metadata (introspected: a single out arg, `sa{sv}`).

- `path`: absolute path of the image in the user's Pictures directory — GNOME
  saves captures below `<Pictures>/<localized "Screenshots">`. Paths outside that
  directory, relative paths, unsupported extensions and oversized files are
  rejected.
- `options`: reserved for future use; pass `{}` in v1.
- struct member 1, `text`: recognised text with line breaks preserved. Lines are
  ordered top-to-bottom and words left-to-right within a line.
- struct member 2, `meta`:
  - `elapsed_ms` (`d`): OCR wall time for this image.
  - `line_count` (`i`): number of detected lines.
  - `confidence` (`d`): mean recognition confidence in `[0, 1]`.

### `GetStatus () → (ssas)`

Returns the engine state without loading models, as **one unnamed struct**
(introspected: a single out arg, `ssas`).

- struct member 1, `state`: `"loading"` while the models are being loaded,
  `"ready"` once they are, `"models-missing"` when `install-models` has not been
  run, `"error"` when the load failed for another reason.
- struct member 2, `version`: the engine version string.
- struct member 3, `models`: the model files **present on disk**, not the ones
  the engine expects, so a partial install is visible here.

## Errors

Error names take the form `io.github.Selianos.Grape1.Error.<Name>`.

| Name | Meaning | Extension action |
| --- | --- | --- |
| `NoText` | No text was detected in the image | "No text found" |
| `BadImage` | The path is not a readable image in the Pictures directory, or is too large | "Failed to copy" |
| `ModelMissing` | The models were never installed | "Failed to copy" + install-guide notification |

Any other failure raises a generic `io.github.Selianos.Grape1.Error.Failed`
(`GrapeError.dbus_name` defaults to `Failed`) and is logged and surfaced as
"Failed to copy".

## CLI hint (the service has no CLI)

The service is driven by D-Bus only. Installation is handled by the four
`grape-engine` commands in `docs/INSTALL.md`; `grape-engine doctor` reports the
install state.

## Example

```bash
# Warm up and read a screenshot (model cold start is hidden behind your selection)
gdbus call --session --dest io.github.Selianos.Grape1 \
  --object-path /io/github/Selianos/Grape1 --method io.github.Selianos.Grape1.Warmup

gdbus call --session --dest io.github.Selianos.Grape1 \
  --object-path /io/github/Selianos/Grape1 \
  --method io.github.Selianos.Grape1.Recognize \
  "'/home/you/Pictures/Screenshots/Screenshot from 2026-10-10 09-00-00.png'" '{}'
# gdbus parses each argument as a GVariant, so a path with spaces needs the
# inner single quotes

gdbus call --session --dest io.github.Selianos.Grape1 \
  --object-path /io/github/Selianos/Grape1 \
  --method io.github.Selianos.Grape1.GetStatus
# (('ready', '1.0.0', ['det.onnx', 'rec.onnx', 'cls.onnx']),)
```

Both methods return a single struct, so the output is nested one level deeper
than a plain tuple: `GetStatus` prints `(('ready', '1.0.0', [...]),)` and
`Recognize` prints `(('the text', {'elapsed_ms': <d>, 'line_count': <i>, 'confidence': <d>}),)`.
