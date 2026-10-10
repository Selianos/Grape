# Grape

Grab text from your screen with **RapidOCR**, as a GNOME Shell extension.

Press your own keyboard shortcut, drag a box around some text in GNOME's
screenshot UI, and the English text — lines and paragraphs, with their line
breaks — lands on your clipboard with a **Text copied** notification. No
screenshot editing, no window switching, no manual OCR step.

```
[shortcut] ──▶ Warmup (fire-and-forget) ──▶ [screenshot UI opens]
                                       └──▶ you select a region
[file saved] ──▶ Recognize(file) ──▶ [clipboard text] + notification
```

## What it does

- **One shortcut.** You set the binding in preferences; Grape ships with none.
- **Area selection only.** Uses GNOME's built-in screenshot UI, so capture is
  the same as the desktop's own.
- **Offline OCR.** Models are fetched once at install time into
  `~/.local/share/grape/models`; the engine never touches the network at runtime.
- **Fast.** The engine starts the moment you press the shortcut, so its cold
  start overlaps your selection. Only the recognition itself counts toward the
  1.25 s budget.
- **Clean results.** Text is grouped into lines (top to bottom, left to right)
  and joined with line breaks.
- **Safe.** Nothing runs at login; the engine is started by the session bus on
  demand and exits after 120 s idle. No `wl-copy`, no external binaries.

> **v1 scope:** English text, CPU only, single lines and paragraphs. Arabic,
> auto-delete and other settings are planned after v1.

## Installation

On Fedora, from a checkout of this repository (the engine is not published to
PyPI yet):

```sh
cd /path/to/grape
sudo dnf install pipx python3.13
pipx install --python python3.13 ./service
pipx ensurepath
grape-engine install-models    # one-time download; offline from then on
grape-engine install-dbus      # registers the service with the session bus
```

Then install the [Grape extension](https://extensions.gnome.org/) and set a
shortcut in its preferences.

## Using it

Set a shortcut in **Grape → Settings**, then press it and drag a box around text.
The text is copied to the clipboard. **No text found** appears when the engine
detects nothing; **Failed to copy** covers any other error (notably "engine not
installed", which links to the install guide).

## Repository layout

```
extension/     → the GNOME Shell extension (zipped for EGO)
service/       → the Python OCR service (grape-engine)
```

## Development

The extension lives in `extension/` and is zipped for
[extensions.gnome.org](https://extensions.gnome.org/). The engine is a single
Python package in `service/`.
`grape-engine install-models` guesses which RapidOCR model files to use; the
expected `det`/`rec`/`cls` names are not yet confirmed against a real install, so
run `grape-engine doctor` right after and report any mismatch.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
