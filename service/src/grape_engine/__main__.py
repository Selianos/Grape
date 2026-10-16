"""D-Bus service for Grape, started on demand by session-bus activation.

Runs ``io.github.Selianos.Grape1`` at ``/io/github/Selianos/Grape1``. Inference
runs on a worker thread so ``GetStatus`` answers while a job is in progress. The
service exits after ``IDLE_TIMEOUT_S`` with no calls; the bus restarts it on the
next one, so nothing runs at login.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sys
import time
from pathlib import Path

from dbus_fast import BusType, DBusError, RequestNameReply, Variant
from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, method

from . import __version__
from .ocr import ModelMissingError, OCREngine, GrapeError
from .paths import (
    BUS_NAME,
    IDLE_TIMEOUT_S,
    IMAGE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    MODELS_DIR,
    OBJECT_PATH,
    pictures_dir,
    dbus_error,
)

log = logging.getLogger("grape_engine")


class GrapeService(ServiceInterface):
    """Exports the three OCR methods consumed by the extension."""

    def __init__(self) -> None:
        super().__init__(BUS_NAME)
        self._engine = OCREngine(MODELS_DIR)
        self._state = "loading"  # 'loading' until models are ready, then 'ready'
        self._last_activity = time.monotonic()
        self._load_lock = asyncio.Lock()

    # -- helpers ------------------------------------------------------------

    def _touch(self) -> None:
        self._last_activity = time.monotonic()

    def _idle_for(self) -> float:
        return time.monotonic() - self._last_activity

    async def _ensure_loaded(self) -> None:
        """Load the engine exactly once. Safe to call from several methods.

        A failure has to move the state too: a state stuck on 'loading' tells
        the user to wait for something that will never finish.
        """
        async with self._load_lock:
            if self._engine._loaded:
                return
            try:
                await asyncio.to_thread(self._engine.load)
            except ModelMissingError:
                self._state = "models-missing"
                raise
            except Exception:
                self._state = "error"
                raise
            self._state = "ready"

    def _validate_path(self, raw_path: str) -> Path:
        """Reject anything that is not an image in the user's pictures folder.

        Keeps the service boundary narrow: the extension only ever passes paths
        written by GNOME's screenshot UI.
        """
        path = Path(raw_path)
        if not path.is_absolute():
            raise DBusError(dbus_error("BadImage"), f"path must be absolute: {raw_path}")

        try:
            resolved = path.resolve()
            root = pictures_dir().resolve()
        except OSError as exc:
            raise DBusError(dbus_error("BadImage"), f"bad path: {exc}") from exc

        if not resolved.is_relative_to(root):
            raise DBusError(
                dbus_error("BadImage"),
                f"file is outside the pictures folder ({root})")
        if resolved.suffix.lower() not in IMAGE_EXTENSIONS:
            raise DBusError(dbus_error("BadImage"), f"unsupported image type: {resolved.suffix}")
        if not resolved.is_file():
            raise DBusError(dbus_error("BadImage"), f"not a file: {resolved}")
        size = resolved.stat().st_size
        if size > MAX_IMAGE_BYTES:
            raise DBusError(dbus_error("BadImage"), f"image too large ({size} bytes)")
        return resolved

    # -- D-Bus methods ------------------------------------------------------

    @method()
    def GetStatus(self) -> "(ssas)":
        """Return (state, version, model files present on disk)."""
        self._touch()
        present = [
            name for name in self._engine.MODEL_FILES
            if (MODELS_DIR / name).is_file()
        ]
        return (self._state, __version__, present)

    @method()
    async def Warmup(self) -> "":
        """Load the models if not loaded. The extension calls this without waiting."""
        self._touch()
        try:
            await self._ensure_loaded()
        except GrapeError as exc:
            # Surface the install-guide error to a caller that awaits; the
            # extension deliberately does not await, so this usually logs only.
            raise DBusError(dbus_error(exc.dbus_name), exc.message) from exc

    @method()
    async def Recognize(self, path: "s", options: "a{sv}") -> "(sa{sv})":
        """OCR one image and return (text, meta)."""
        self._touch()
        image_path = self._validate_path(path)
        try:
            await self._ensure_loaded()
            result = await asyncio.to_thread(self._engine.recognize, image_path)
        except GrapeError as exc:
            raise DBusError(dbus_error(exc.dbus_name), exc.message) from exc

        meta = {
            "elapsed_ms": Variant("d", float(result.elapsed_ms)),
            "line_count": Variant("i", result.line_count),
            "confidence": Variant("d", float(result.confidence)),
        }
        return (result.text, meta)


async def _idle_monitor(service: GrapeService, bus: MessageBus) -> None:
    """Exit the process once the service has been idle long enough.

    Sleeps only as long as the remaining budget so the documented timeout is
    the real one, rather than the timeout plus a poll interval.
    """
    while True:
        remaining = IDLE_TIMEOUT_S - service._idle_for()
        if remaining <= 0:
            log.info("idle for %.0fs, exiting", service._idle_for())
            bus.disconnect()
            return
        await asyncio.sleep(min(remaining, 5))


async def _serve() -> None:
    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    service = GrapeService()
    bus.export(OBJECT_PATH, service)

    reply = await bus.request_name(BUS_NAME)
    if reply is not RequestNameReply.PRIMARY_OWNER:
        # Another engine already owns the name; do not linger holding a
        # connection and an object no caller can reach.
        log.warning("%s already owned (%s); exiting", BUS_NAME, reply.name)
        bus.disconnect()
        return

    log.info("Grape engine %s running on %s (%s)", __version__, BUS_NAME, OBJECT_PATH)

    idle_task = asyncio.create_task(_idle_monitor(service, bus))
    try:
        # A dropped connection is how this process is meant to end — both the
        # idle monitor's own disconnect and the bus going away surface here.
        with contextlib.suppress(EOFError):
            await bus.wait_for_disconnect()
    finally:
        idle_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await idle_task


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # pragma: no cover - unexpected bus failure
        log.exception("engine failed: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
