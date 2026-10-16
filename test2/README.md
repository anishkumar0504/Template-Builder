# ProjectX PDF Template Builder (local-first backend)

This is a standalone implementation of the Phase A template-builder pipeline discussed for ProjectX:

**PDF → measurable extraction + page PNGs → Gemini template spec → schema validation → editable saved JSON → DOCX generation.**

It writes everything locally under `output/`. It does not require a database. You supply your own Gemini API key.

## What it does

- Reads PDF text spans, font family/size/flags, text colors, coordinates, page dimensions, vector drawings/lines/rectangles, embedded image references and image assets using PyMuPDF.
- Renders page previews to PNG for visual analysis.
- Sends extracted measurements plus selected page previews to Gemini with a strict JSON response schema.
- Saves `extraction.json`, `template-spec.json`, PNG previews, and extracted images in one output job folder.
- Validates the returned spec with Zod before saving.
- Offers a local API to upload/analyze a PDF, read/edit a spec, and generate a DOCX using the saved spec and supplied content.
- Provides CLI commands for local-folder processing.

## Important limitations

No generic pipeline can guarantee exact, pixel-identical output for every PDF. Scanned PDFs have no real font metadata; this version flags missing text layers but does not automatically OCR them. The sample DOCX renderer applies page dimensions/margins and basic header/footer/section structure, but it does **not** yet reproduce every arbitrary coordinate, complex table, background image, or page-specific layout exactly. Use the `layout_elements` and preview PNGs for a review/editor loop before claiming a template is production-perfect. DOCX reflow differs from PDF. This implementation is a working baseline, not a claim of universal 1:1 reconstruction.

## Requirements

- Node.js 20+ (22 recommended)
- Python 3.10+
- Gemini API key
- Install Python packages from `requirements.txt`

Windows PowerShell:

```powershell
cd projectx-template-builder
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env and set GEMINI_API_KEY
npm install
npm run check
npm start
```

macOS/Linux:

```bash
cd projectx-template-builder
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env and set GEMINI_API_KEY
npm install
npm run check
npm start
```

`python`/`python3` must resolve to the interpreter where PyMuPDF is installed. Set `PYTHON` in your shell if needed, e.g. `PYTHON=.venv/bin/python` on Linux/macOS. In PowerShell, `$env:PYTHON='.venv\Scripts\python.exe'`.

## Local-folder workflow

1. Put a PDF in `input/`, for example `input/dypiu-practical.pdf`.
2. Run API server: `npm start`.
3. In another terminal, request analysis:

```bash
curl -X POST http://localhost:8000/api/templates/analyze-local \
  -H 'Content-Type: application/json' \
  -d '{"file":"dypiu-practical.pdf"}'
```

Or use CLI directly:

```bash
npm run analyze -- ./input/dypiu-practical.pdf
```

A job directory is created under `output/` containing:

```text
extraction.json          measured PDF data
pages/page-001.png       rendered previews
assets/                  extracted embedded images
 template-spec.json      validated reusable template
```

Review the previews and `template-spec.json` before using the spec for important documents.

## HTTP API

### `GET /health`
Confirms service status and whether a Gemini key is configured.

### `POST /api/templates/upload-and-analyze`
Multipart form-data with one PDF field named `pdf`. Returns the template spec and local output paths.

### `POST /api/templates/analyze-local`
JSON: `{"file":"my-template.pdf"}`. The filename must be directly inside `input/` (path traversal is blocked).

### `GET /api/templates/:job/spec`
Read a saved spec. `:job` is the output job folder name returned by the analysis endpoint.

### `PATCH /api/templates/:job/spec`
Send the edited template spec fields as JSON. The result is schema-validated before it is saved. For safety, send a complete valid spec or an object whose merged result remains valid.

### `POST /api/templates/:job/generate-docx`
JSON body:

```json
{
  "filename": "cloud-practical",
  "content": {
    "title": "Experiment 01: Cloud Computing",
    "aim": "To study cloud computing.",
    "theory": "...",
    "procedure": ["Step one", "Step two"],
    "result": "Completed successfully."
  }
}
```

Returns the generated `.docx` as a download. Content keys should match `sections[].key` and `variable_fields[].key` in the saved spec.

## Generate from CLI

Create your content JSON from `content.example.json`, then:

```bash
npm run generate -- ./output/JOB_FOLDER ./content.json
```

## Prompt / injection safety

The full analysis prompt is in `prompts/template-analysis.md`. PDF text is explicitly treated as untrusted input; the model is instructed not to follow commands found in the document and to return structured JSON only. The API does not execute model-generated code. Never put the Gemini key in frontend code or commit `.env`.

## Before production

- Add auth, per-user ownership checks, rate limits and file retention/deletion policy.
- Run PDF extraction in an isolated worker/container with CPU, memory, page-count and timeout limits.
- Add OCR (Tesseract/PaddleOCR) for scanned pages.
- Render DOCX to PDF with LibreOffice, compare original and generated page images, and add a review/patch loop.
- Add tests with actual DYPIU and other university templates. Keep human review for low-confidence detection.
- Persist specs and asset references in your existing Prisma/PostgreSQL model; this baseline writes files locally.


## Windows PDF extraction note (PyMuPDF-free mode)

This version uses `pdfplumber`, so it does not import PyMuPDF/`fitz` or its native `_mupdf` DLL. Page previews are rendered with Poppler's `pdftoppm`.

1. Activate the virtual environment and install dependencies:
   ```powershell
   .venv\\Scripts\\Activate.ps1
   python -m pip install -r requirements.txt
   ```
2. Install Poppler for Windows and add the folder containing `pdftoppm.exe` to PATH. Open a new PowerShell and verify:
   ```powershell
   where.exe pdftoppm
   ```
3. Run:
   ```powershell
   npm run analyze -- ./input/dypiu-practical.pdf
   ```

The pipeline automatically prefers `.venv`'s Python. Set `PYTHON` in `.env` only if you want to override it. This removes the blocked PyMuPDF native DLL from the extraction path; it does not bypass Windows Application Control policy.
