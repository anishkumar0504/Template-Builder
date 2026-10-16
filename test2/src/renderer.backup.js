
import fs from "node:fs/promises";
import path from "node:path";

import {
  AlignmentType,
  Document,
  ImageRun,
  LineRuleType,
  PageBreak,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

const FONT_FALLBACK = "Times New Roman";
const PT_TO_TWIPS = 20;

function pt(value) {
  return Math.max(0, Math.round(Number(value || 0) * PT_TO_TWIPS));
}

function safeColor(value) {
  const color = String(value || "#000000").replace("#", "");
  return /^[0-9a-fA-F]{6}$/.test(color)
    ? color.toUpperCase()
    : "000000";
}

function lineText(line) {
  return String(line?.text ?? "").replace(/\u0000/g, "");
}

function lineStyle(line) {
  const style = line?.style || {};
  const rawFont = String(
    style.font_family || line?.font || FONT_FALLBACK
  );

  const font = /timesnewroman/i.test(rawFont)
    ? FONT_FALLBACK
    : rawFont.replace(/^[A-Z]{4,}\+/, "");

  return {
    font,
    size: Math.max(
      5,
      Math.min(
        48,
        Number(
          style.font_size_pt ||
          line?.font_size_pt ||
          11
        )
      )
    ),
    color: safeColor(
      style.color_hex || line?.color_hex
    ),
    bold: /bold|demi|heavy/i.test(rawFont) ||
      Boolean(style.bold),
    italics: /italic|oblique/i.test(rawFont) ||
      Boolean(style.italic),
  };
}

async function loadImage(jobDir, image) {
  if (!image?.asset) return null;

  const root = path.resolve(jobDir);
  const imagePath = path.resolve(root, image.asset);

  if (!imagePath.startsWith(root + path.sep)) {
    return null;
  }

  let data;

  try {
    data = await fs.readFile(imagePath);
  } catch {
    return null;
  }

  const bbox = Array.isArray(image.bbox)
    ? image.bbox.map(Number)
    : [];

  if (
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite)
  ) {
    return null;
  }

  const width = Math.max(1, bbox[2] - bbox[0]);
  const height = Math.max(1, bbox[3] - bbox[1]);

  const extension = path.extname(image.asset).toLowerCase();
  const type =
    extension === ".jpg" || extension === ".jpeg"
      ? "jpg"
      : "png";

  return {
    x: bbox[0],
    y: bbox[1],
    width,
    height,
    run: new ImageRun({
      data,
      type,
      transformation: {
        width,
        height,
      },
    }),
  };
}

export async function generateDocx({
  specPath,
  contentPath,
  outputPath,
}) {
  const jobDir = path.dirname(path.resolve(specPath));

  const [specRaw, contentRaw, extractionRaw] =
    await Promise.all([
      fs.readFile(specPath, "utf8"),
      fs.readFile(path.resolve(contentPath), "utf8"),
      fs.readFile(
        path.join(jobDir, "extraction.json"),
        "utf8"
      ),
    ]);

  const spec = JSON.parse(specRaw);
  const content = JSON.parse(contentRaw);
  const extraction = JSON.parse(extractionRaw);

  const pages = extraction.pages || [];

  if (!pages.length) {
    throw new Error(
      "extraction.json contains no pages."
    );
  }

  const children = [];
  let editableTextLines = 0;
  let insertedImageRegions = 0;

  for (let pageIndex = 0;
    pageIndex < pages.length;
    pageIndex++
  ) {
    const page = pages[pageIndex];

    const lines = page.text_lines || [];
    const images = page.images || [];

    const elements = [];

    for (const line of lines) {
      const bbox = Array.isArray(line.bbox)
        ? line.bbox.map(Number)
        : [];

      if (
        bbox.length !== 4 ||
        !bbox.every(Number.isFinite) ||
        !lineText(line).trim()
      ) {
        continue;
      }

      elements.push({
        kind: "text",
        x: bbox[0],
        y: bbox[1],
        bbox,
        line,
      });
    }

    for (const image of images) {
      const bbox = Array.isArray(image.bbox)
        ? image.bbox.map(Number)
        : [];

      if (
        bbox.length === 4 &&
        bbox.every(Number.isFinite)
      ) {
        elements.push({
          kind: "image",
          x: bbox[0],
          y: bbox[1],
          bbox,
          image,
        });
      }
    }

    elements.sort(
      (a, b) => a.y - b.y || a.x - b.x
    );

    // A new page must start on a new Word page.
    if (pageIndex > 0) {
      children.push(
        new Paragraph({
          children: [new PageBreak()],
        })
      );
    }

    let cursorY = 0;

    for (const element of elements) {
      const [, y0, , y1] = element.bbox;

      const gapBefore = Math.max(
        0,
        y0 - cursorY
      );

      if (element.kind === "text") {
        const value = lineText(element.line);
        const style = lineStyle(element.line);

        const lineHeight = Math.max(
          6,
          y1 - y0
        );

        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,

            indent: {
              left: pt(Math.max(0, element.x)),
            },

            spacing: {
              before: pt(gapBefore),
              after: 0,
              line: pt(lineHeight),
              lineRule: LineRuleType.EXACT,
            },

            keepLines: true,

            children: [
              new TextRun({
                text: value,
                font: style.font,
                size: Math.round(style.size * 2),
                color: style.color,
                bold: style.bold,
                italics: style.italics,
              }),
            ],
          })
        );

        editableTextLines++;
        cursorY = Math.max(cursorY, y1);
      } else {
        const image = await loadImage(
          jobDir,
          element.image
        );

        if (!image) continue;

        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,

            indent: {
              left: pt(Math.max(0, image.x)),
            },

            spacing: {
              before: pt(
                Math.max(0, image.y - cursorY)
              ),
              after: 0,
              line: pt(Math.max(6, image.height)),
              lineRule: LineRuleType.EXACT,
            },

            keepLines: true,

            children: [image.run],
          })
        );

        cursorY = Math.max(
          cursorY,
          image.y + image.height
        );

        insertedImageRegions++;
      }
    }
  }

  const pageWidth = Number(
    pages[0].width_pt ||
    spec.page?.width_pt ||
    595.32
  );

  const pageHeight = Number(
    pages[0].height_pt ||
    spec.page?.height_pt ||
    841.92
  );

  const document = new Document({
    creator: "ProjectX Template Builder",

    title:
      content.practical_title ||
      spec.template_name ||
      "Practical Report",

    description:
      "Coordinate-based editable reconstruction " +
      "from extracted PDF text and images.",

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
              footer: 0,
              gutter: 0,
            },
          },
        },

        children,
      },
    ],
  });

  const finalPath = path.resolve(outputPath);

  await fs.mkdir(
    path.dirname(finalPath),
    { recursive: true }
  );

  await fs.writeFile(
    finalPath,
    await Packer.toBuffer(document)
  );

  return {
    outputPath: finalPath,
    mode: "coordinate-based editable reconstruction",
    sourcePages: pages.length,
    editableTextLines,
    insertedImageRegions,
    note:
      "Text lines use extracted coordinates and styles. " +
      "Vector drawings, complete table reconstruction, " +
      "page borders, and content replacement still need " +
      "additional implementation.",
  };
}
