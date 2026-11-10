# Troubleshooting Grape

Work through these in order. Start with `grape-engine doctor` — it checks the
Python, model and D-Bus setup in one command and reports the first thing that's
wrong.

## The shortcut does nothing

- **No shortcut is set.** Grape has no default shortcut. Open the extension's
  preferences and click the **Keyboard shortcut** row to record one.
- **The shortcut is already taken.** If another app, extension or GNOME itself
  (for example <kbd>Print</kbd>) already uses the combination, GNOME keeps it
  for them and Grape's shortcut silently does nothing — GNOME gives the
  extension no way to detect this. Pick a different combination, such as
  <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>.
- The screenshot UI does open but nothing is copied afterwards — see the next
  sections.
- Check the Shell log for errors while you press the shortcut:

  ```sh
  journalctl -f -o cat /usr/bin/gnome-shell
  ```

## "Failed to copy" — the engine is not installed

This is the most common first-run problem. Run:

```sh
grape-engine doctor
```

If `grape-engine` is not found, the package is not installed:

```sh
pipx install ./service        # from a checkout; once on PyPI use `pipx install grape-engine`
```

If `doctor` reports a **failed** check, fix what it names:

- **onnxruntime / rapidocr** not installed — reinstall the package:
  `pipx reinstall grape-engine`.
- **models** missing — run `grape-engine install-models` (this needs the network
  once).
- **dbus service file** missing — run `grape-engine install-dbus`.
- **dbus Exec interpreter** missing — the activation file points at a Python
  that no longer exists (after `pipx reinstall` or a Fedora Python upgrade).
  Run `grape-engine install-dbus` again to rewrite it.

After fixing, run `doctor` again until every line says `ok`. Then press your
shortcut again. The engine is started by the session bus on demand, so no
re-login is needed.

## "No text found"

The region was selected but the engine did not detect any text:

- Choose a tighter crop around the text; large empty areas are fine, but the
  box should cover the words.
- Ensure the text is readably sized and not covered by overlays.
- If a crop that clearly contains text reports "No text found", it is a bug —
  check the Shell log and report it with the screenshot.

## The engine never starts / D-Bus errors

If the engine was installed but the service does not activate, confirm the
activation file points at the right Python:

```sh
cat ~/.local/share/dbus-1/services/io.github.Selianos.Grape1.service
```

It should contain `Exec=<path-to-python> -m grape_engine`. After `pipx
reinstall`, pipx may create a new environment path; re-run
`grape-engine install-dbus` to update the file.

You can test the service directly with `gdbus` (this starts it if needed):

```sh
gdbus call --session \
  --dest io.github.Selianos.Grape1 \
  --object-path /io/github/Selianos/Grape1 \
  --method io.github.Selianos.Grape1.GetStatus
```

## High-DPI / fractional scaling

OCR cost scales with how much text is in the selection — the number of words the
detector finds, not the file's size and not the pixel count. A single-line or
paragraph selection is recognised well inside the 1.25 s budget; a dense full-screen
capture is not, because recognition runs once per detected word and a 4K frame can
hold a few hundred of them (measured at 3–4 s on the reference machine).

The engine rejects files over 20 MiB and bitmaps over 40 megapixels (both are
sanity bounds, not latency bounds), and downscales any selection whose long edge
exceeds 2560 px before recognition. That downscale trims detection cost but does
not change the per-word recognition cost, so it does not make a dense full-screen
capture fast. If a large selection feels slow, select a smaller region.

## A job does not show up in the log view, or shows the wrong text

The log lives in `~/.local/state/grape/jobs.jsonl` and is trimmed to the last 50
entries. Expanding **Show log** in preferences reads that file, newest first. If
the file is missing or empty, no job was recorded — check the Shell log for the
reason. Use the trash button to clear it.

By default the log stores only how many characters were recognised, not the
text itself, because a screen capture can contain passwords. Turn on **Store
recognised text** in preferences if you want the text kept.

If you have disabled saving to disk (the `org.gnome.desktop.lockdown
disable-save-to-disk` setting), GNOME's screenshot UI writes no file and Grape
has nothing to read, so the shortcut does nothing.

## Still stuck

Check the Shell log and include the output of `grape-engine doctor` when you
report the issue. The `doctor` output and the exact error message from the
notification are usually enough to identify the cause.
