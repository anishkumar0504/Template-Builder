
import argparse
import json
import sys
import hashlib
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
from PIL import Image

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None


def rounded(value, digits=3):
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return value


def json_safe(value):
    """Convert PDF-library values to JSON-compatible values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    return str(value)


def bbox(item):
    keys = ("x0", "top", "x1", "bottom")
    if not all(item.get(k) is not None for k in keys):
        return None
    return [rounded(item[k]) for k in keys]


def color_hex(color):
    """Convert grayscale or RGB-like PDF colors to a hex string."""
    if color is None:
        return None

    if isinstance(color, (int, float)):
        values = [float(color)] * 3
    elif isinstance(color, (list, tuple)):
        if len(color) == 1:
            values = [float(color[0])] * 3
        elif len(color) >= 3:
            values = [float(v) for v in color[:3]]
        else:
            return None
    else:
        return None

    values = [max(0, min(1, v)) for v in values]
    rgb = [round(v * 255) for v in values]
    return "#" + "".join(f"{v:02X}" for v in rgb)


def extract_character(char):
    return {
        "text": char.get("text", ""),
        "bbox": bbox(char),
        "origin": [
            rounded(char.get("x0")),
            rounded(char.get("doctop", char.get("top"))),
        ],
        "font": char.get("fontname"),
        "font_size_pt": rounded(char.get("size")),
        "color": json_safe(char.get("non_stroking_color")),
        "color_hex": color_hex(char.get("non_stroking_color")),
        "stroke_color": json_safe(char.get("stroking_color")),
        "width": rounded(char.get("width")),
        "height": rounded(char.get("height")),
        "upright": char.get("upright"),
        "matrix": json_safe(char.get("matrix")),
        "adv": rounded(char.get("adv")),
        "mcid": char.get("mcid"),
        "tag": char.get("tag"),
        "object_type": char.get("object_type"),
    }


def extract_drawing(kind, item, index):
    points = item.get("pts") or []
    path = item.get("path") or []

    return {
        "id": f"{kind}-{index:05d}",
        "type": kind,
        "bbox": bbox(item),
        "stroke": json_safe(item.get("stroking_color")),
        "stroke_hex": color_hex(item.get("stroking_color")),
        "fill": json_safe(item.get("non_stroking_color")),
        "fill_hex": color_hex(item.get("non_stroking_color")),
        "stroke_width": rounded(item.get("linewidth")),
        "dash": json_safe(item.get("dash")),
        "fill_rule": item.get("fill_rule"),
        "line_cap": item.get("linecap"),
        "line_join": item.get("linejoin"),
        "close_path": item.get("closePath"),
        "pts": json_safe(points),
        "path": json_safe(path),
        "mcid": item.get("mcid"),
        "tag": item.get("tag"),
        "object_type": item.get("object_type"),
    }


def group_text_lines(chars):
    """Group characters into lines while preserving per-character styles."""
    groups = {}

    for char in chars:
        top = float(char.get("top", 0))
        # Small tolerance avoids splitting normal text on tiny baseline shifts.
        key = round(top / 2.0)
        groups.setdefault(key, []).append(char)

    lines = []

    for group in groups.values():
        group.sort(key=lambda c: float(c.get("x0", 0)))

        text = "".join(c.get("text", "") for c in group)
        if not text.strip():
            continue

        sizes = [
            float(c["size"])
            for c in group
            if c.get("size") is not None
        ]

        lines.append({
            "text": text,
            "bbox": [
                rounded(min(float(c["x0"]) for c in group)),
                rounded(min(float(c["top"]) for c in group)),
                rounded(max(float(c["x1"]) for c in group)),
                rounded(max(float(c["bottom"]) for c in group)),
            ],
            "style": {
                "font_family": group[0].get("fontname"),
                "font_size_pt": rounded(
                    sum(sizes) / len(sizes) if sizes else None
                ),
                "color": json_safe(group[0].get("non_stroking_color")),
                "color_hex": color_hex(
                    group[0].get("non_stroking_color")
                ),
            },
            "chars": [extract_character(c) for c in group],
        })

    return sorted(lines, key=lambda line: (line["bbox"][1], line["bbox"][0]))


def extract_tables(page):
    """Record table candidates; do not treat detection as guaranteed."""
    tables = []

    try:
        found = page.find_tables()
    except Exception:
        found = []

    for index, table in enumerate(found, start=1):
        cells = []

        for cell in (table.cells or []):
            if not cell:
                cells.append(None)
                continue

            cells.append([
                rounded(v) for v in cell
            ])

        try:
            matrix = table.extract()
        except Exception:
            matrix = None

        tables.append({
            "id": f"table-{index:03d}",
            "bbox": [rounded(v) for v in table.bbox],
            "cells": cells,
            "rows": json_safe(matrix),
        })

    return tables


def extract_rendered_images(page, preview_path, assets_dir, page_num):
    """
    Keep the existing rendered-crop method for placement previews.
    These crops are NOT original embedded image bytes.
    """
    results = []

    with Image.open(preview_path) as rendered:
        scale_x = rendered.width / float(page.width)
        scale_y = rendered.height / float(page.height)

        for index, item in enumerate((page.images or []), start=1):
            box = bbox(item)
            if not box:
                continue

            x0, top, x1, bottom = box
            crop_box = (
                max(0, int(x0 * scale_x)),
                max(0, int(top * scale_y)),
                min(rendered.width, int(x1 * scale_x)),
                min(rendered.height, int(bottom * scale_y)),
            )

            left, upper, right, lower = crop_box
            if right <= left or lower <= upper:
                continue

            filename = f"page-{page_num:03d}-crop-{index:03d}.png"
            output = assets_dir / filename
            rendered.crop(crop_box).save(output, format="PNG")

            results.append({
                "id": f"image-region-{index:03d}",
                "bbox": box,
                "asset": f"assets/{filename}",
                "asset_kind": "rendered_crop",
                "width_px": right - left,
                "height_px": lower - upper,
                "pdf_object": json_safe(item),
            })

    return results


def extract_original_images(pdf_path, assets_dir):
    """
    Extract original embedded image streams where pypdf supports them.
    Image placement is recorded separately by pdfplumber; matching an
    extracted image stream to a particular placement may need validation.
    """
    results = []

    if PdfReader is None:
        return results

    try:
        reader = PdfReader(str(pdf_path))

        for page_num, page in enumerate(reader.pages, start=1):
            try:
                images = page.images
            except Exception:
                continue

            for index, image in enumerate(images, start=1):
                try:
                    data = image.data
                    if not data:
                        continue

                    suffix = Path(
                        getattr(image, "name", "") or "image.bin"
                    ).suffix.lower()

                    if not suffix or len(suffix) > 8:
                        suffix = ".bin"

                    digest = hashlib.sha256(data).hexdigest()[:12]
                    filename = (
                        f"original-p{page_num:03d}-"
                        f"i{index:03d}-{digest}{suffix}"
                    )

                    output = assets_dir / filename
                    output.write_bytes(data)

                    results.append({
                        "page": page_num,
                        "index": index,
                        "name": getattr(image, "name", None),
                        "asset": f"assets/{filename}",
                        "asset_kind": "original_embedded_stream",
                        "bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                    })
                except Exception as exc:
                    results.append({
                        "page": page_num,
                        "index": index,
                        "error": str(exc),
                    })
    except Exception as exc:
        results.append({"extraction_error": str(exc)})

    return results


def main():
    parser = argparse.ArgumentParser(
        description="Deep PDF extraction for ProjectX Template Builder"
    )
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--dpi", type=int, default=200)
    args = parser.parse_args()

    pdf_path = Path(args.pdf).resolve()
    out = Path(args.out).resolve()

    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    if args.dpi < 72 or args.dpi > 600:
        raise ValueError("--dpi must be between 72 and 600")

    pages_dir = out / "pages"
    assets_dir = out / "assets"
    pages_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    previews = []
    document = pdfium.PdfDocument(str(pdf_path))

    try:
        for index in range(len(document)):
            page = document[index]
            try:
                bitmap = page.render(scale=args.dpi / 72)
                image = bitmap.to_pil()
                filename = f"page-{index + 1:03d}.png"
                image.save(pages_dir / filename, format="PNG")
                previews.append(f"pages/{filename}")
            finally:
                page.close()
    finally:
        document.close()

    extracted_pages = []
    all_assets = []

    with pdfplumber.open(str(pdf_path)) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            raw_chars = list(page.chars or [])

            chars = [extract_character(c) for c in raw_chars]
            text_lines = group_text_lines(raw_chars)

            drawings = []
            drawing_index = 0

            for kind, collection in (
                ("line", page.lines),
                ("rect", page.rects),
                ("curve", page.curves),
            ):
                for item in collection or []:
                    drawing_index += 1
                    drawing = extract_drawing(
                        kind, item, drawing_index
                    )
                    if drawing["bbox"] is not None:
                        drawings.append(drawing)

            edges = []
            for edge_index, item in enumerate(page.edges or [], start=1):
                edge = extract_drawing("edge", item, edge_index)
                if edge["bbox"] is not None:
                    edges.append(edge)

            words = []
            try:
                for word_index, word in enumerate(
                    page.extract_words(
                        x_tolerance=1,
                        y_tolerance=2,
                        extra_attrs=["fontname", "size"],
                    ),
                    start=1,
                ):
                    words.append({
                        "id": f"word-{word_index:05d}",
                        "text": word.get("text", ""),
                        "bbox": bbox(word),
                        "font": word.get("fontname"),
                        "font_size_pt": rounded(word.get("size")),
                    })
            except Exception:
                pass

            preview_path = out / previews[index - 1]
            images = extract_rendered_images(
                page, preview_path, assets_dir, index
            )

            for image in images:
                all_assets.append({
                    "file": image["asset"],
                    "purpose": "rendered_image_crop",
                    "page": index,
                })

            text = page.extract_text() or ""
            tables = extract_tables(page)

            extracted_pages.append({
                "page": index,
                "width_pt": rounded(page.width),
                "height_pt": rounded(page.height),
                "rotation": int(getattr(page, "rotation", 0) or 0),
                "coordinate_system": {
                    "unit": "pt",
                    "origin": "top-left",
                    "bbox_order": ["x0", "top", "x1", "bottom"],
                },
                "text": text,
                "chars": chars,
                "words": words,
                "text_lines": text_lines,
                "blocks": text_lines,
                "drawings": drawings,
                "edges": edges,
                "tables": tables,
                "images": images,
                "preview": previews[index - 1],
                "has_text_layer": bool(text.strip()),
                "object_counts": {
                    "chars": len(chars),
                    "words": len(words),
                    "text_lines": len(text_lines),
                    "drawings": len(drawings),
                    "edges": len(edges),
                    "tables": len(tables),
                    "images": len(images),
                },
            })

    original_images = extract_original_images(pdf_path, assets_dir)

    for image in original_images:
        if "asset" in image:
            all_assets.append({
                "file": image["asset"],
                "purpose": "original_embedded_stream",
                "page": image.get("page"),
            })

    result = {
        "schema_version": "2.0.0",
        "source_file": pdf_path.name,
        "page_count": len(extracted_pages),
        "metadata": json_safe(pdf.metadata or {}),
        "render_settings": {
            "engine": "pypdfium2",
            "dpi": args.dpi,
        },
        "assets": all_assets,
        "original_embedded_images": original_images,
        "pages": extracted_pages,
        "notes": [
            "Coordinates are in PDF points with top-origin bounding boxes.",
            "Rendered page previews are raster images.",
            "Rendered image crops are not original embedded image streams.",
            "Original image streams are extracted separately when supported.",
            "Image stream order does not prove image placement correspondence.",
            "Drawing paths and table detection depend on PDF structure.",
            "Text grouping is heuristic; character-level data is retained.",
            "Exact reconstruction requires a renderer to consume this geometry.",
            "Scanned pages may require OCR.",
        ],
    }

    target = out / "extraction.json"
    target.write_text(
        json.dumps(result, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )

    print(json.dumps({
        "ok": True,
        "page_count": len(extracted_pages),
        "asset_count": len(all_assets),
        "original_image_count": len(original_images),
        "output": str(target),
        "preview_dir": str(pages_dir),
        "assets_dir": str(assets_dir),
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Extraction failed: {error}", file=sys.stderr)
        sys.exit(1)
