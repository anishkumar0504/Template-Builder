
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import {
  AlignmentType,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
  PageBreak,
  LineRuleType,
} from "docx";

const PT_TO_TWIPS = 20;
const FONT_FALLBACK = "Times New Roman";

function pt(value) {
  return Math.max(0, Math.round(Number(value || 0) * PT_TO_TWIPS));
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeColor(value) {
  if (Array.isArray(value)) {
    const rgb = value.slice(0, 3).map((v) =>
      Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255)
        .toString(16).padStart(2, "0")
    );
    return rgb.join("").toUpperCase();
  }

  const color = String(value || "#000000").replace("#", "");
  return /^[0-9a-fA-F]{6}$/.test(color)
    ? color.toUpperCase()
    : "000000";
}

function lineStyle(line) {
  const style = line?.style || {};
  const rawFont = String(style.font_family || FONT_FALLBACK);
  const font = /timesnewroman/i.test(rawFont)
    ? FONT_FALLBACK
    : rawFont.replace(/^[A-Z]{4,}\+/, "");

  return {
    font,
    size: Math.max(
      5,
      Math.min(48, Number(style.font_size_pt || 11))
    ),
    color: safeColor(style.color_hex || style.color),
    bold: /bold|demi|heavy/i.test(rawFont) || Boolean(style.bold),
    italics: /italic|oblique/i.test(rawFont) || Boolean(style.italic),
  };
}

function safeAssetPath(jobDir, relativePath) {
  if (!relativePath) return null;

  const root = path.resolve(jobDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return target;
}

async function makeImageRun(jobDir, image) {
  const imagePath = safeAssetPath(jobDir, image?.asset);
  const bbox = Array.isArray(image?.bbox) ? image.bbox.map(Number) : [];

  if (!imagePath || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
    return null;
  }

  let data;
  try {
    data = await fs.readFile(imagePath);
  } catch {
    return null;
  }

  const width = Math.max(1, bbox[2] - bbox[0]);
  const height = Math.max(1, bbox[3] - bbox[1]);
  const ext = path.extname(imagePath).toLowerCase();

  return {
    x: bbox[0],
    y: bbox[1],
    width,
    height,
    run: new ImageRun({
      data,
      type: ext === ".jpg" || ext === ".jpeg" ? "jpg" : "png",
      transformation: { width, height },
    }),
  };
}

/**
 * Adds page border and footer XML to the generated DOCX.
 * The border is positioned from the page edge, and PAGE is a Word field.
 */
async function patchDocumentXml(buffer, options) {
  const zip = await JSZip.loadAsync(buffer);

  const documentFile = zip.file("word/document.xml");
  if (!documentFile) {
    throw new Error("Generated DOCX is missing word/document.xml");
  }

  let documentXml = await documentFile.async("string");

  const borderXml = `
    <w:pgBorders w:offsetFrom="page">
      <w:top w:val="single" w:sz="6" w:space="24" w:color="000000"/>
      <w:left w:val="single" w:sz="6" w:space="24" w:color="000000"/>
      <w:bottom w:val="single" w:sz="6" w:space="24" w:color="000000"/>
      <w:right w:val="single" w:sz="6" w:space="24" w:color="000000"/>
    </w:pgBorders>`;

  const footerReference =
    '<w:footerReference w:type="default" r:id="rIdProjectXFooter"/>';

  if (!documentXml.includes('r:id="rIdProjectXFooter"')) {
    documentXml = documentXml.replace(
      /<w:sectPr\b([^>]*)>/,
      (match) => `${match}${footerReference}`
    );
  }

  if (!documentXml.includes("<w:pgBorders")) {
    documentXml = documentXml.replace(
      "</w:sectPr>",
      `${borderXml}</w:sectPr>`
    );
  }

  zip.file("word/document.xml", documentXml);

  // Link the footer part from document.xml.
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);

  if (!relsFile) {
    throw new Error("Generated DOCX is missing document relationships");
  }

  let relsXml = await relsFile.async("string");

  if (!relsXml.includes('Id="rIdProjectXFooter"')) {
    relsXml = relsXml.replace(
      "</Relationships>",
      '<Relationship Id="rIdProjectXFooter" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" ' +
        'Target="footer1.xml"/></Relationships>'
    );
  }

  zip.file(relsPath, relsXml);

  // Register footer1.xml in [Content_Types].xml.
  const typesFile = zip.file("[Content_Types].xml");
  if (!typesFile) {
    throw new Error("Generated DOCX is missing [Content_Types].xml");
  }

  let typesXml = await typesFile.async("string");

  if (!typesXml.includes("/word/footer1.xml")) {
    typesXml = typesXml.replace(
      "</Types>",
      '<Override PartName="/word/footer1.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
        "</Types>"
    );
  }

  zip.file("[Content_Types].xml", typesXml);

  const footerText = xmlEscape(options.prn || "PRN:");

  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr>
      <w:spacing w:before="0" w:after="0" w:line="200" w:lineRule="exact"/>
      <w:ind w:left="${pt(391.75)}"/>
      <w:jc w:val="left"/>
    </w:pPr>
    <w:r>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>
        <w:sz w:val="20"/>
      </w:rPr>
      <w:t xml:space="preserve">${footerText} </w:t>
    </w:r>
    <w:r>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>
        <w:sz w:val="20"/>
      </w:rPr>
      <w:fldChar w:fldCharType="begin"/>
    </w:r>
    <w:r>
      <w:instrText xml:space="preserve"> PAGE </w:instrText>
    </w:r>
    <w:r>
      <w:fldChar w:fldCharType="separate"/>
    </w:r>
    <w:r>
      <w:t>1</w:t>
    </w:r>
    <w:r>
      <w:fldChar w:fldCharType="end"/>
    </w:r>
  </w:p>
</w:ftr>`;

  zip.file("word/footer1.xml", footerXml);

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

export async function generateDocx({ specPath, contentPath, outputPath }) {
  const jobDir = path.dirname(path.resolve(specPath));

  const [specRaw, contentRaw, extractionRaw] = await Promise.all([
    fs.readFile(specPath, "utf8"),
    fs.readFile(path.resolve(contentPath), "utf8"),
    fs.readFile(path.join(jobDir, "extraction.json"), "utf8"),
  ]);

  const spec = JSON.parse(specRaw.replace(/^\uFEFF/, ""));
  const content = JSON.parse(contentRaw.replace(/^\uFEFF/, ""));
  const extraction = JSON.parse(extractionRaw.replace(/^\uFEFF/, ""));

  const pages = Array.isArray(extraction.pages) ? extraction.pages : [];
  if (!pages.length) {
    throw new Error("extraction.json contains no pages");
  }

  const children = [];
  let lineCount = 0;
  let imageCount = 0;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];

    const elements = [];

    for (const line of page.text_lines || []) {
      const bbox = Array.isArray(line.bbox) ? line.bbox.map(Number) : [];
      if (bbox.length !== 4 || !bbox.every(Number.isFinite)) continue;
      if (!String(line.text || "").trim()) continue;

      elements.push({
        kind: "text",
        x: bbox[0],
        y: bbox[1],
        bbox,
        line,
      });
    }

    for (const image of page.images || []) {
      const bbox = Array.isArray(image.bbox) ? image.bbox.map(Number) : [];
      if (bbox.length !== 4 || !bbox.every(Number.isFinite)) continue;

      elements.push({
        kind: "image",
        x: bbox[0],
        y: bbox[1],
        bbox,
        image,
      });
    }

    elements.sort((a, b) => a.y - b.y || a.x - b.x);

    let cursorY = 0;

    for (const element of elements) {
      const [x0, y0, x1, y1] = element.bbox;
      const gap = Math.max(0, y0 - cursorY);

      if (element.kind === "text") {
        const line = element.line;
        const style = lineStyle(line);
        const text = String(line.text || "").replace(/\u0000/g, "");
        const height = Math.max(6, y1 - y0);

        // Avoid duplicating the original page-specific footer.
        if (y0 > 785 && /^\s*PRN:/i.test(text)) {
          cursorY = Math.max(cursorY, y1);
          continue;
        }

        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            indent: { left: pt(Math.max(0, x0)) },
            spacing: {
              before: pt(gap),
              after: 0,
              line: pt(height),
              lineRule: LineRuleType.EXACT,
            },
            keepLines: true,
            children: [
              new TextRun({
                text,
                font: style.font,
                size: Math.round(style.size * 2),
                color: style.color,
                bold: style.bold,
                italics: style.italics,
              }),
            ],
          })
        );

        lineCount++;
        cursorY = Math.max(cursorY, y1);
      } else {
        const positioned = await makeImageRun(jobDir, element.image);
        if (!positioned) continue;

        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            indent: { left: pt(Math.max(0, positioned.x)) },
            spacing: {
              before: pt(gap),
              after: 0,
              line: pt(Math.max(6, positioned.height)),
              lineRule: LineRuleType.EXACT,
            },
            keepLines: true,
            children: [positioned.run],
          })
        );

        cursorY = Math.max(cursorY, positioned.y + positioned.height);
        imageCount++;
      }
    }

    if (pageIndex < pages.length - 1) {
      children.push(
        new Paragraph({
          children: [new PageBreak()],
        })
      );
    }
  }

  const firstPage = pages[0];
  const pageWidth = Number(firstPage.width_pt || spec.page?.width_pt || 595.32);
  const pageHeight = Number(firstPage.height_pt || spec.page?.height_pt || 841.92);

  // Extract the PRN value from the original footer if content.json doesn't supply it.
  const sourceFooter = pages
    .flatMap((page) => page.text_lines || [])
    .map((line) => String(line.text || ""))
    .find((text) => /^\s*PRN:/i.test(text));

  const extractedPrn = sourceFooter
    ? sourceFooter.replace(/^\s*(PRN:\s*\S+)\s+\d+\s*$/i, "$1")
    : "PRN:";

  const prn = content.prn || content.student_prn || extractedPrn;

  const doc = new Document({
    creator: "ProjectX Template Builder",
    title: content.practical_title || spec.template_name || "Practical Report",
    sections: [
      {
        properties: {
          page: {
            size: {
              width: pt(pageWidth),
              height: pt(pageHeight),
            },
            margin: {
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              header: 0,
              footer: pt(25),
              gutter: 0,
            },
          },
        },
        children,
      },
    ],
  });

  const initialBuffer = await Packer.toBuffer(doc);
  const finalBuffer = await patchDocumentXml(initialBuffer, { prn });

  const finalPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, finalBuffer);

  return {
    outputPath: finalPath,
    mode: "coordinate-aware with page border and dynamic footer",
    sourcePages: pages.length,
    editableTextLines: lineCount,
    insertedImageRegions: imageCount,
    pageBorder: {
      left: 24,
      top: 24,
      right: 571.44,
      bottom: 818.04,
    },
    footer: "PRN plus dynamic PAGE field",
    note:
      "Border and footer are restored. Table-grid reconstruction and exact text positioning still require visual validation.",
  };
}
