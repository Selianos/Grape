# Installing Grape

Grape is a GNOME Shell extension that grabs text from the screen with
[RapidOCR](https://github.com/RapidAI/RapidOCR). It has two parts:

- **The extension** (GJS, inside GNOME Shell) handles the shortcut, the
  region selection, the clipboard and notifications.
- **The engine** (`grape-engine`, a Python D-Bus service) runs RapidOCR outside
  the Shell. It is started automatically when you press your shortcut, so
  nothing runs at login.

The engine is installed with four commands; the extension is installed from
extensions.gnome.org. The reference distro is Fedora with GNOME 50 on Wayland.

## 1. Install the engine

The engine needs Python 3 and a package manager for pip packages. The current
`rapidocr`/`onnxruntime` releases build on Python 3.14 (verified with Python 3.14.7),
so the checkout install uses the default interpreter — no separate Python 3.13
needed:

```sh
sudo dnf install pipx
```

Install the engine into its own isolated environment. From a checkout of this
repository (the package is not yet on PyPI):

```sh
cd /path/to/grape
pipx install ./service
pipx ensurepath          # add ~/.local/bin to PATH; open a new shell after
```

Once published to PyPI, this becomes the usual:

```sh
pipx install grape-engine
```

Fetch the OCR models once. This is the only step that touches the network;
after it the engine never downloads anything again. The models go into
`~/.local/share/grape/models`:

```sh
grape-engine install-models
```

> **For the first real test:** `install-models` guesses which `det`/`rec`/`cls` ONNX files
> belong to your RapidOCR. This is confirmed against a real RapidOCR install
> (det/rec = PP-OCRv4, cls = mobile v2.0), but still run `grape-engine doctor`
> afterwards to confirm the files landed; if the filenames look wrong that is a
> bug worth reporting.

Register the service with your session bus so it can be started on demand:

```sh
grape-engine install-dbus
```

Check that everything is in place:

```sh
grape-engine doctor
```

`doctor` should print `ok` for Python, `onnxruntime`, `rapidocr`, the model
files and the D-Bus service file. It exits with a non-zero status if any check
fails.

> **Linux / Wayland** — the engine and the extension talk over the **session**
> D-Bus, which is available on the Wayland session already.

## 2. Install the extension

Open [Grape on extensions.gnome.org](https://extensions.gnome.org/extension/?uuid=grape@selianos.github.io)
and turn it on. You can also install it locally from a checkout:

```sh
cd /path/to/grape
# gnome-extensions pack includes metadata.json, extension.js, prefs.js and
# schemas/ by default, so lib/ and prefs.ui must be named explicitly. The zip
# is written to the current directory as grape@selianos.github.io.shell-extension.zip.
gnome-extensions pack extension \
  --extra-source=lib \
  --extra-source=prefs.ui \
  --force --out-dir=.
gnome-extensions install grape@selianos.github.io.shell-extension.zip
gnome-extensions enable grape@selianos.github.io
```

## 3. Set a shortcut

Grape ships with **no default shortcut** (GNOME forbids extensions that ship a
default binding that touches the clipboard). On first enable, a notification
"Set a shortcut to start" appears; click **Open preferences**.

In the preferences window, in the **Shortcut** group, click the **OCR shortcut**
row and press a key combination such as <kbd>Ctrl</kbd>+<kbd>T</kbd>. Press
<kbd>Backspace</kbd> in the capture dialog to clear it.

## 4. Use it

1. Press your shortcut. GNOME's screenshot UI opens in area-selection mode;
   the engine starts loading in the background at the same moment.
2. Drag a box around the text you want, then press <kbd>Enter</kbd>.
3. A **Text copied** notification appears and the text is on your clipboard,
   ready to paste. Line breaks are preserved.

## Uninstalling

Remove the engine's data and its D-Bus registration, then the package:

```sh
grape-engine uninstall
pipx uninstall grape-engine
```

Then disable the extension in the Extensions app.

## What gets installed where

| Path | What it holds |
| --- | --- |
| `~/.local/share/grape/models` | `det.onnx`, `rec.onnx`, `cls.onnx` |
| `~/.local/share/dbus-1/services/io.github.Selianos.Grape1.service` | D-Bus activation file |
| `~/.local/state/grape/jobs.jsonl` | Last 50 jobs (read by preferences) |

Nothing else is written. The extension and engine never need `sudo` and never
touch the network at runtime.
