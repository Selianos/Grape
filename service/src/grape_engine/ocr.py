"""RapidOCR wrapper with line grouping.

The engine is built once and kept warm between jobs. Models are loaded from a local
directory (``~/.local/share/grape/models``) at install time; we never let RapidOCR
reach the network. Every public entry point raises one of the ``GrapeError``
subclasses so the D-Bus layer can translate them into named bus errors.

Box grouping rules (v1): detected boxes are sorted top-to-bottom, clustered into
lines by vertical overlap, then sorted left-to-right within each line. Lines are
joined with a single newline (paragraph line breaks are preserved).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class GrapeError(Exception):
    """Base class for errors surfaced over D-Bus."""

    #: suffix appended to the D-Bus error root, e.g. ``...Error.NoText``
    dbus_name = "Failed"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class NoTextError(GrapeError):
    dbus_name = "NoText"


class BadImageError(GrapeError):
    dbus_name = "BadImage"


class ModelMissingError(GrapeError):
    dbus_name = "ModelMissing"


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------


@dataclass
class RecognitionResult:
    text: str
    line_count: int = 0
    confidence: float = 0.0
    elapsed_ms: int = 0
    boxes: list[Any] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Line grouping
# ---------------------------------------------------------------------------


def _center_y(box: Any) -> float:
    """Vertical centre of a quadrilateral box (array-like of 4 points)."""
    try:
        ys = [float(p[1]) for p in box]
        return sum(ys) / len(ys)
    except (TypeError, IndexError):
        return 0.0


def _center_x(box: Any) -> float:
    try:
        xs = [float(p[0]) for p in box]
        return sum(xs) / len(xs)
    except (TypeError, IndexError):
        return 0.0


def _y_span(box: Any) -> tuple[float, float]:
    """Top/bottom of a quadrilateral box."""
    ys = [float(p[1]) for p in box]
    return min(ys), max(ys)


def group_into_lines(items: Sequence[tuple[Any, str, float]]) -> list[list[tuple[Any, str, float]]]:
    """Group (box, text, score) items into lines.

    Items are clustered into one line when their vertical spans overlap by at
    least half of the smaller box height. Words that share a baseline but differ
    slightly in box extent (descenders, commas, punctuation) thus stay on the
    same line, while genuinely separate rows do not merge. Within a line items
    are ordered left-to-right; lines are returned top-to-bottom.
    """
    if not items:
        return []

    lines: list[list[tuple[Any, str, float]]] = []

    for item in items:
        top, bottom = _y_span(item[0])
        item_h = max(bottom - top, 1.0)
        placed = False
        # Join the first existing line that shares enough vertical extent.
        for line in lines:
            spans = [_y_span(i[0]) for i in line]
            line_top = min(s[0] for s in spans)
            line_bottom = max(s[1] for s in spans)
            line_h = max(line_bottom - line_top, 1.0)
            overlap = min(bottom, line_bottom) - max(top, line_top)
            if overlap > 0.5 * min(item_h, line_h):
                line.append(item)
                placed = True
                break
        if not placed:
            lines.append([item])

    # Sort lines top-to-bottom, items left-to-right within a line.
    lines.sort(key=lambda line: _center_y(min(line, key=lambda i: _center_y(i[0]))[0]))
    for line in lines:
        line.sort(key=lambda i: _center_x(i[0]))
    return lines


def join_lines(lines: Sequence[Sequence[tuple[Any, str, float]]]) -> tuple[str, int, float]:
    """Turn grouped lines into (text, line_count, mean_confidence)."""
    texts: list[str] = []
    scores: list[float] = []
    for line in lines:
        line_text = " ".join(part[1].strip() for part in line if part[1].strip())
        if line_text:
            texts.append(line_text)
            scores.extend(part[2] for part in line)
    text = "\n".join(texts)
    confidence = sum(scores) / len(scores) if scores else 0.0
    return text, len(texts), confidence


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class OCREngine:
    """Owns a single RapidOCR instance and runs recognition.

    ``load()`` builds the engine with explicit local model paths and no
    downloads. It is safe to call repeatedly; the model is loaded once.
    """

    #: model file names we require inside ``model_dir`` (install-models writes these).
    MODEL_FILES = ("det.onnx", "rec.onnx", "cls.onnx")

    def __init__(self, model_dir: str | Path):
        self._model_dir = Path(model_dir)
        self._engine: Any = None
        self._loaded = False

    def _model_path(self, name: str) -> Path:
        return self._model_dir / name

    def ensure_models(self) -> None:
        """Raise ``ModelMissingError`` if any required model file is absent.

        This pre-flight check means RapidOCR is never given a chance to download
        the model at runtime: if a file is missing we fail before calling it.
        """
        missing = [name for name in self.MODEL_FILES if not self._model_path(name).is_file()]
        if missing:
            raise ModelMissingError(
                "missing model file(s): "
                + ", ".join(missing)
                + f" in {self._model_dir} (run `grape-engine install-models`)"
            )

    def load(self) -> None:
        """Build the RapidOCR engine. Idempotent."""
        if self._loaded:
            return
        self.ensure_models()
        try:
            from rapidocr import RapidOCR
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise GrapeError("rapidocr is not installed") from exc

        params = {
            "Global.text_score": 0.5,
            "Global.use_det": True,
            "Global.use_cls": True,
            "Global.use_rec": True,
            "Det.model_path": str(self._model_path("det.onnx")),
            "Rec.model_path": str(self._model_path("rec.onnx")),
            "Cls.model_path": str(self._model_path("cls.onnx")),
        }
        engine = RapidOCR(params=params)
        self._engine = engine
        self._loaded = True


    def recognize(self, image_path: str | Path) -> RecognitionResult:
        """OCR one image file and return grouped text and metadata."""
        if not self._loaded:
            self.load()

        image_path = Path(image_path)
        if not image_path.is_file():
            raise BadImageError(f"not a file: {image_path}")

        start = time.perf_counter()
        try:
            raw = self._engine(str(image_path))
        except Exception as exc:  # RapidOCR raises assorted errors on bad input
            raise BadImageError(f"could not read image: {exc}") from exc
        elapsed_ms = int(round((time.perf_counter() - start) * 1000))

        if raw is None:
            raise NoTextError("no text found")

        items = self._extract_items(raw)
        if not items:
            raise NoTextError("no text found")

        lines = group_into_lines(items)
        text, line_count, confidence = join_lines(lines)
        if not text:
            raise NoTextError("no text found")

        return RecognitionResult(
            text=text,
            line_count=line_count,
            confidence=round(confidence, 4),
            elapsed_ms=elapsed_ms,
            boxes=[item[0] for item in items],
        )

    @staticmethod
    def _extract_items(raw: Any) -> list[tuple[Any, str, float]]:
        """Normalise RapidOCR output into (box, text, score) tuples.

        Handles the object-attribute style of rapidocr v2 and the list style of
        the retired ``rapidocr_onnxruntime`` package so the wrapper is resilient
        to the API shape.
        """
        items: list[tuple[Any, str, float]] = []
        # v2: object with .boxes / .txts / .scores attributes.
        boxes = getattr(raw, "boxes", None)
        txts = getattr(raw, "txts", None)
        scores = getattr(raw, "scores", None)
        if boxes is not None and txts is not None:
            for i, box in enumerate(boxes):
                text = str(txts[i]) if i < len(txts) else ""
                score = float(scores[i]) if scores is not None and i < len(scores) else 1.0
                if text.strip():
                    items.append((box, text, score))
            return items
        # legacy: result, elapse = engine(...) -> list of [box, text, score]
        if isinstance(raw, (list, tuple)):
            for entry in raw:
                if isinstance(entry, (list, tuple)) and len(entry) >= 3:
                    box, text, score = entry[0], str(entry[1]), float(entry[2])
                    if text.strip():
                        items.append((box, text, score))
        return items
