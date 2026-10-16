import sys
import json
import pdfplumber

def extract(pdf_path):
    data = {"pages": []}
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            page_data = {
                "width": float(page.width),
                "height": float(page.height),
                "chars": [],
                "lines": [],
                "rects": [],
                "images": []
            }
            
            # Extract characters
            for char in page.chars:
                page_data["chars"].append({
                    "text": char["text"],
                    "fontname": char["fontname"],
                    "size": float(char["size"]),
                    "x0": float(char["x0"]),
                    "y0": float(char["top"]), # pdfplumber uses 'top' for y0
                    "x1": float(char["x1"]),
                    "y1": float(char["bottom"]),
                    "color": char.get("non_stroking_color")
                })
                
            # Extract lines
            for line in page.lines:
                page_data["lines"].append({
                    "x0": float(line["x0"]),
                    "y0": float(line["top"]),
                    "x1": float(line["x1"]),
                    "y1": float(line["bottom"]),
                    "color": line.get("non_stroking_color"),
                    "linewidth": float(line.get("linewidth", 1))
                })
                
            # Extract rectangles
            for rect in page.rects:
                page_data["rects"].append({
                    "x0": float(rect["x0"]),
                    "y0": float(rect["top"]),
                    "x1": float(rect["x1"]),
                    "y1": float(rect["bottom"]),
                    "color": rect.get("non_stroking_color"),
                    "fill": rect.get("non_stroking_color"),
                    "linewidth": float(rect.get("linewidth", 1))
                })
                
            # Extract image bounding boxes
            for img in page.images:
                page_data["images"].append({
                    "x0": float(img["x0"]),
                    "y0": float(img["top"]),
                    "x1": float(img["x1"]),
                    "y1": float(img["bottom"]),
                    "name": img.get("name", "image")
                })
                
            data["pages"].append(page_data)
            
    return data

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 extract.py <pdf_file>")
        sys.exit(1)
    
    pdf_file = sys.argv[1]
    result = extract(pdf_file)
    
    out_file = pdf_file.replace(".pdf", "_extracted.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(f"Extraction saved to {out_file}")