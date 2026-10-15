# Troubleshooting Grape

Work through these in order. Start with `grape-engine doctor` — it checks the
Python, model and D-Bus setup in one command and reports the first thing that's
wrong.

## The shortcut does nothing

- **No shortcut is set.** Grape has no default shortcut. Open the extension's
  preferences and click the **OCR shortcut** row to record one.
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

At 200% scaling a crop holds four times the pixels, which can push a large
paragraph past the 1.25 s budget. The extension caps the image size it will pass
to the engine (20 MiB). If large selections feel slow, select smaller regions.

## A job does not show up in the log view, or shows the wrong text

The log lives in `~/.local/state/grape/jobs.jsonl` and is trimmed to the last 50
entries. The preferences **Show log** dialog reads that file, newest first. If
the file is missing or empty, no job was recorded — check the Shell log for the
reason. Use **Clear log** to empty it.

## Still stuck

Check the Shell log and include the output of `grape-engine doctor` when you
report the issue. The `doctor` output and the exact error message from the
notification are usually enough to identify the cause.
