"""Command-line helpers: ``grape-engine install-models|install-dbus|uninstall|doctor``.

These are the four commands from docs/INSTALL.md that prepare the engine. Models
are copied from the rapidocr package, plus one download of the English
recogniser, at install time only and never at runtime; the D-Bus activation file is
written here so the session bus can start the service on the first call.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import shutil
import sys
import urllib.request
from pathlib import Path

from . import __version__
from .ocr import OCREngine
from .paths import (
    BUS_NAME,
    DATA_DIR,
    MODELS_DIR,
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


#: Models copied from the rapidocr package. Its bundled recogniser is the Chinese
#: one, which drops most spaces between English words, so it is not used.
BUNDLED_ROLES = ("det", "cls")

#: RapidOCR's English recogniser, pinned to the release and checksum that
#: rapidocr 2.1.0 lists in its own default_models.yaml. Fetched once by
#: install-models; the engine never downloads anything at runtime.
REC_EN_URL = (
    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v2.1.0/"
    "onnx/PP-OCRv4/rec/en_PP-OCRv4_rec_infer.onnx"
)
REC_EN_SHA256 = "e8770c967605983d1570cdf5352041dfb68fa0c21664f49f47b155abd3e0e318"
REC_EN_FILE = "rec-en.onnx"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _install_rec_en() -> bool:
    """Download the English recogniser, verify it, and move it into place."""
    dest = MODELS_DIR / REC_EN_FILE
    if dest.is_file() and _sha256(dest) == REC_EN_SHA256:
        print(f"  - {dest.name}  already installed")
        return True

    partial = dest.with_suffix(".part")
    print(f"  - {dest.name}  downloading {REC_EN_URL}")
    try:
        with urllib.request.urlopen(REC_EN_URL, timeout=60) as response, partial.open("wb") as f:
            shutil.copyfileobj(response, f)
    except OSError as exc:
        partial.unlink(missing_ok=True)
        print(f"error: could not download the English recognition model: {exc}", file=sys.stderr)
        return False

    if _sha256(partial) != REC_EN_SHA256:
        partial.unlink()
        print("error: the downloaded recognition model failed its checksum; not installed",
              file=sys.stderr)
        return False
    partial.replace(dest)
    return True


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
        if role in BUNDLED_ROLES:
            candidates.setdefault(role, []).append(src)

    missing = [role for role in BUNDLED_ROLES if role not in candidates]
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

    print(f"installing models into {MODELS_DIR}:")
    for role in BUNDLED_ROLES:
        src = candidates[role][0]
        dest = MODELS_DIR / f"{role}.onnx"
        shutil.copyfile(src, dest)
        print(f"  - {dest.name}  <- {src.name}")

    if not _install_rec_en():
        return 1

    # The Chinese recogniser from earlier versions; nothing loads it any more.
    stale = MODELS_DIR / "rec.onnx"
    if stale.is_file():
        stale.unlink()
        print(f"  - removed the old {stale.name}")
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
    check("models", not missing,
          f"missing {', '.join(missing)} (run grape-engine install-models)" if missing
          else f"found in {MODELS_DIR}")
    rec_en = MODELS_DIR / REC_EN_FILE
    if rec_en.is_file():
        check("English recognition model", _sha256(rec_en) == REC_EN_SHA256,
              "checksum ok" if _sha256(rec_en) == REC_EN_SHA256
              else "checksum mismatch (run grape-engine install-models)")
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
