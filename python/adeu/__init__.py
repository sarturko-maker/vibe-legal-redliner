from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from adeu.ingest import extract_text_from_stream
from adeu.markup import apply_edits_to_markdown
from adeu.models import DocumentEdit
from adeu.redline.engine import RedlineEngine

try:
    __version__ = version("adeu")
except PackageNotFoundError:
    # Package is loaded via filesystem injection (e.g., Pyodide in Chrome extension).
    # Read the pinned version from the VERSION file bundled alongside this package.
    _version_file = Path(__file__).parent / "VERSION"
    if _version_file.is_file():
        __version__ = _version_file.read_text().strip()
    else:
        __version__ = "0.0.0-dev"

__all__ = [
    "RedlineEngine",
    "DocumentEdit",
    "extract_text_from_stream",
    "apply_edits_to_markdown",
    "__version__",
]
