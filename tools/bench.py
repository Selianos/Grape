#!/usr/bin/env python3
"""Latency benchmark for the Grape OCR engine.

Measures the 1.25 s budget on the reference machine. Expects a directory of
crops split into ``lines/`` and ``paragraphs/`` subfolders:

    tools/crops/lines/*.png        single-line crops
    tools/crops/paragraphs/*.png   multi-line paragraph crops

It reports the cold-start (engine + model load) time and, per group, the warm
recognition time as median, p95 and worst. Run without arguments to use the
default crop folder; any image under the folder is measured.

Usage: python tools/bench.py [crop_dir]
"""

from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path
from typing import Sequence

try:
    from grape_engine.ocr import OCREngine
    from grape_engine.paths import MODELS_DIR
except ImportError:  # run from the service/ source tree
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "service" / "src"))
    from grape_engine.ocr import OCREngine  # type: ignore
    from grape_engine.paths import MODELS_DIR  # type: ignore


def _collect(crop_dir: Path) -> dict[str, list[Path]]:
    groups: dict[str, list[Path]] = {}
    for folder in ("lines", "paragraphs"):
        base = crop_dir / folder
        if base.exists():
            groups[folder] = sorted(
                p for p in base.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
            )
    if not any(groups.values()):
        raise SystemExit(
            f"no crops found under {crop_dir} (expected {crop_dir}/lines and"
            f" {crop_dir}/paragraphs)"
        )
    return groups


def _stats(times: Sequence[float]) -> tuple[float, float, float]:
    if not times:
        return (0.0, 0.0, 0.0)
    return (
        statistics.median(times),
        sorted(times)[int(len(times) * 0.95)] if len(times) else 0.0,
        max(times),
    )


def main(argv: list[str] | None = None) -> int:
    crop_dir = Path(argv[0]) if argv else Path(__file__).resolve().parent / "crops"
    groups = _collect(crop_dir)

    engine = OCREngine(MODELS_DIR)

    # Cold start: build and load the engine once.
    cold_start = time.perf_counter()
    engine.load()
    cold_ms = (time.perf_counter() - cold_start) * 1000

    results: dict[str, list[float]] = {}
    for name, files in groups.items():
        times: list[float] = []
        for f in files:
            start = time.perf_counter()
            try:
                engine.recognize(f)
            except Exception as exc:  # a crop the engine can't read
                print(f"  [skip] {f.name}: {exc}")
                continue
            times.append((time.perf_counter() - start) * 1000)
        results[name] = times

    print(f"crop dir     : {crop_dir}")
    print(f"models       : {MODELS_DIR}")
    print(f"cold start   : {cold_ms:.1f} ms")
    print()
    for name, times in results.items():
        med, p95, worst = _stats(times)
        print(f"{name:<12} n={len(times):<3} median={med:7.1f} ms  p95={p95:7.1f} ms  worst={worst:7.1f} ms")

    total = sum(len(t) for t in results.values())
    if total:
        flush = max(_stats(v)[2] for v in results.values())
        print()
        print(f"warm worst   : {flush:.1f} ms  (budget 1250 ms)")
        if flush > 1250:
            print("WARNING: worst warm recognition exceeds the 1.25 s budget")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
