"""Path and constant definitions shared by the service and the CLI helpers."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

# -- D-Bus identity ---------------------------------------------------------
BUS_NAME = "io.github.Selianos.Grape1"
OBJECT_PATH = "/io/github/Selianos/Grape1"
ERROR_ROOT = f"{BUS_NAME}.Error"
CONNECTION_NAME = f"{BUS_NAME}.service"  # Name= line in the activation file

# -- Data locations ---------------------------------------------------------
# Everything lives under the user's home; no root needed for the engine.
DATA_DIR = Path.home() / ".local" / "share" / "grape"
MODELS_DIR = DATA_DIR / "models"
STATE_DIR = Path.home() / ".local" / "state" / "grape"
LOG_FILE = STATE_DIR / "jobs.jsonl"

SERVICE_FILE_DIR = Path.home() / ".local" / "share" / "dbus-1" / "services"
SERVICE_FILE = SERVICE_FILE_DIR / f"{BUS_NAME}.service"

# -- Behaviour --------------------------------------------------------------
#: The engine quits after this long with no D-Bus calls; the bus restarts it.
IDLE_TIMEOUT_S = 120

#: Reject images larger than this. Large paragraph crops are the slow case;
#: this cap keeps a single job inside the 1.25 s budget.
MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MiB

#: Recognised file extensions for an image passed to ``Recognize``.
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def pictures_dir() -> Path:
    """Resolve the user's Pictures directory the way GNOME's own UI does.

    GNOME saves captures to ``<Pictures>/<localized "Screenshots">``. Both
    halves are translated and the first is user-configurable, so neither can be
    hardcoded: honour the environment, then user-dirs.dirs, then the
    xdg-user-dir helper, and only then fall back to ``~/Pictures``.
    """
    env = os.environ.get("XDG_PICTURES_DIR")
    if env:
        return Path(os.path.expandvars(env)).expanduser()

    config_home = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    try:
        for line in (config_home / "user-dirs.dirs").read_text(encoding="utf-8").splitlines():
            match = re.match(r'\s*XDG_PICTURES_DIR\s*=\s*"(.*)"\s*$', line)
            if match:
                value = match.group(1).replace("$HOME", str(Path.home()))
                return Path(value).expanduser()
    except OSError:
        pass

    try:
        result = subprocess.run(
            ["xdg-user-dir", "PICTURES"],
            capture_output=True, text=True, timeout=5, check=True,
        )
        if result.stdout.strip():
            return Path(result.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass

    return Path.home() / "Pictures"


def dbus_error(name: str) -> str:
    """Qualified D-Bus error name, e.g. ``...Error.NoText``."""
    return f"{ERROR_ROOT}.{name}"


def ensure_dirs() -> None:
    """Create the directories the engine and log rely on."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
