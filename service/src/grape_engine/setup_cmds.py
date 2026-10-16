"""Command-line helpers: ``grape-engine install-models|install-dbus|uninstall|doctor``.

These are the four commands from docs/INSTALL.md that prepare the engine. Models
are fetched once at install time and never at runtime; the D-Bus activation file is
written here so the session bus can start the service on the first call.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import shutil
import sys
from pathlib import Path

from . import __version__
from .ocr import OCREngine
from .paths import (
    BUS_NAME,
    DATA_DIR,
    MODELS_DIR,
    OBJECT_PATH,
    SERVICE_FILE,
    SERVICE_FILE_DIR,
    ensure_dirs,
    pictures_dir,
)


def _find_rapidocr_models() -> list[Path]:
    """Locate the ONNX model files shipped or materialised by ``rapidocr``.

    RapidOCR v2 keeps its default models inside the package directory; on first
    run it may validate and fetch them there. We copy them out so the engine never
    needs the network afterwards.
    """
    try:
        import rapidocr
    except ImportError as exc:
        print("error: rapidocr is not installed", file=sys.stderr)
        raise SystemExit(1) from exc

    pkg_dir = Path(rapidocr.__file__).resolve().parent
    onnx_files = sorted(pkg_dir.rglob("*.onnx"))
    if not onnx_files:
        # Try to materialise the bundled models by instantiating the engine.
        try:
            from rapidocr import RapidOCR

            RapidOCR()
        except Exception as exc:  # pragma: no cover - depends on environment
            print(f"error: could not materialise RapidOCR models: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc
        onnx_files = sorted(pkg_dir.rglob("*.onnx"))
    return onnx_files


#: Every role install-models must resolve before it reports success.
REQUIRED_ROLES = ("det", "rec", "cls")


def cmd_install_models() -> int:
    ensure_dirs()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    onnx_files = _find_rapidocr_models()
    if not onnx_files:
        print("error: no .onnx models found in the rapidocr package", file=sys.stderr)
        return 1

    candidates: dict[str, list[Path]] = {}
    for src in onnx_files:
        role = _classify_model(src.name)
        if role is not None:
            candidates.setdefault(role, []).append(src)

    missing = [role for role in REQUIRED_ROLES if role not in candidates]
    if missing:
        print(f"error: no model found for: {', '.join(missing)}", file=sys.stderr)
        print(f"  candidates were: {', '.join(f.name for f in onnx_files)}", file=sys.stderr)
        return 1

    # Refuse to pick for the user: the detection model is the single biggest
    # lever on the latency budget, so a silent sort-order win is not acceptable.
    ambiguous = {r: v for r, v in candidates.items() if len(v) > 1}
    if ambiguous:
        print("error: several files match the same role; refusing to guess:", file=sys.stderr)
        for role, files in sorted(ambiguous.items()):
            print(f"  {role}: {', '.join(f.name for f in files)}", file=sys.stderr)
        return 1

    installed: list[tuple[str, Path, Path]] = []
    for role in REQUIRED_ROLES:
        src = candidates[role][0]
        dest = MODELS_DIR / f"{role}.onnx"
        shutil.copyfile(src, dest)
        installed.append((role, src, dest))

    print(f"installed {len(installed)} model(s) into {MODELS_DIR}:")
    for role, src, dest in installed:
        print(f"  - {dest.name}  <- {src.name}")
    return 0


def _classify_model(filename: str) -> str | None:
    """Infer whether an ONNX file is the detection/recognition/classification model."""
    lower = filename.lower()
    if "det" in lower:
        return "det"
    if "cls" in lower:
        return "cls"
    if "rec" in lower:
        return "rec"
    return None


def cmd_install_dbus() -> int:
    """Write the D-Bus activation file pointing at this interpreter."""
    SERVICE_FILE_DIR.mkdir(parents=True, exist_ok=True)
    interpreter = sys.executable
    content = (
        "[D-BUS Service]\n"
        f"Name={BUS_NAME}\n"
        f"Exec={interpreter} -m grape_engine\n"
    )
    SERVICE_FILE.write_text(content, encoding="utf-8")
    print(f"wrote {SERVICE_FILE}")
    print(f"  Name={BUS_NAME}")
    print(f"  Exec={interpreter} -m grape_engine")
    return 0


def cmd_uninstall() -> int:
    """Remove the models directory and the D-Bus activation file."""
    removed = False
    if MODELS_DIR.exists():
        shutil.rmtree(MODELS_DIR)
        print(f"removed {MODELS_DIR}")
        removed = True
    else:
        print(f"nothing at {MODELS_DIR}")

    if SERVICE_FILE.exists():
        SERVICE_FILE.unlink()
        print(f"removed {SERVICE_FILE}")
        removed = True
    else:
        print(f"nothing at {SERVICE_FILE}")

    # Drop the now-empty data dir if it holds nothing else.
    if DATA_DIR.exists() and not any(DATA_DIR.iterdir()):
        DATA_DIR.rmdir()
        print(f"removed empty {DATA_DIR}")

    if not removed:
        print("nothing to remove")
    return 0


def cmd_doctor() -> int:
    """Check the Python, model and bus setup. Print a line per check."""
    ok = True

    def check(label: str, passed: bool, detail: str = "") -> None:
        nonlocal ok
        status = "ok" if passed else "FAIL"
        if not passed:
            ok = False
        line = f"[{status}] {label}"
        if detail:
            line += f" - {detail}"
        print(line)

    check("python", True, sys.version.split()[0])

    try:
        import onnxruntime  # noqa: F401

        check("onnxruntime", True, onnxruntime.__version__)
    except ImportError:
        check("onnxruntime", False, "not installed")

    try:
        import rapidocr  # noqa: F401

        try:
            rapidocr_version = importlib.metadata.version("rapidocr")
        except importlib.metadata.PackageNotFoundError:
            rapidocr_version = getattr(rapidocr, "__version__", "?")
        check("rapidocr", True, rapidocr_version)
    except ImportError:
        check("rapidocr", False, "not installed")

    missing = [n for n in OCREngine.MODEL_FILES if not (MODELS_DIR / n).is_file()]
    check("models", not missing, ", ".join(missing) if missing else f"found in {MODELS_DIR}")
    check("dbus service file", SERVICE_FILE.is_file(), str(SERVICE_FILE))

    # The activation file bakes in sys.executable, so a pipx reinstall or a
    # Fedora Python bump can leave it pointing at an interpreter that is gone.
    # This is the failure TROUBLESHOOTING.md anticipates, so check it here.
    if SERVICE_FILE.is_file():
        exec_path = ""
        for line in SERVICE_FILE.read_text(encoding="utf-8").splitlines():
            if line.startswith("Exec="):
                exec_path = line.removeprefix("Exec=").split()[0]
                break
        check("dbus Exec interpreter", bool(exec_path) and Path(exec_path).is_file(),
              exec_path or "no Exec= line")

    pictures = pictures_dir()
    check("pictures dir", pictures.is_dir(), str(pictures))

    print()
    if not ok:
        print("one or more checks failed; see docs/INSTALL.md", file=sys.stderr)
        return 1
    print(f"grape-engine {__version__}: everything looks good")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="grape-engine",
        description="Install and manage the Grape OCR engine service.",
    )
    parser.add_argument("--version", action="version", version=f"grape-engine {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("install-models", help="fetch the OCR models into ~/.local/share/grape/models")
    sub.add_parser("install-dbus", help="register the D-Bus activation file")
    sub.add_parser("uninstall", help="remove models and the D-Bus file")
    sub.add_parser("doctor", help="check the engine installation")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    commands = {
        "install-models": cmd_install_models,
        "install-dbus": cmd_install_dbus,
        "uninstall": cmd_uninstall,
        "doctor": cmd_doctor,
    }
    return commands[args.command]()


if __name__ == "__main__":
    sys.exit(main())
