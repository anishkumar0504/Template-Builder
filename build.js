const fs = require('fs');
const { 
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, 
    WidthType, AlignmentType, HeadingLevel, BorderStyle 
} = require('docx');

const specPath = process.argv[2];
const outPath = process.argv[3];

if (!specPath || !outPath) {
    console.error("Usage: node build.js <spec.json> <out.docx>");
    process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));

async function build() {
    const sections = [];

    for (const pageSpec of spec.pages) {
        const children = [];

        if (pageSpec.blocks) {
            for (const block of pageSpec.blocks) {
                if (block.type === 'heading') {
                    children.push(new Paragraph({
                        heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
                        children: [
                            new TextRun({
                                text: block.text,
                                bold: block.bold !== false,
                                size: (block.size || 14) * 2, // docx uses half-points
                                font: block.font || "Arial",
                                color: block.color || "000000"
                            })
                        ],
                        alignment: AlignmentType[block.align?.toUpperCase()] || AlignmentType.LEFT
                    }));
                } else if (block.type === 'paragraph') {
                    children.push(new Paragraph({
                        children: [
                            new TextRun({
                                text: block.text,
                                size: (block.size || 12) * 2,
                                font: block.font || "Arial",
                                color: block.color || "000000",
                                bold: block.bold || false,
                                italics: block.italics || false
                            })
                        ],
                        alignment: AlignmentType[block.align?.toUpperCase()] || AlignmentType.LEFT
                    }));
                } else if (block.type === 'table') {
                    const rows = block.rows.map(row => new TableRow({
                        children: row.map(cell => new TableCell({
                            children: [new Paragraph(cell.text)]
                        }))
                    }));
                    children.push(new Table({
                        rows: rows,
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        borders: {
                            top: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                            bottom: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                            left: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                            right: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
                            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "000000" }
                        }
                    }));
                }
            }
        } else {
            children.push(new Paragraph("Error: Could not parse document structure from spec.json"));
        }

        sections.push({ properties: {}, children: children });
    }

    const doc = new Document({ sections });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outPath, buffer);
    console.log(`[BUILD] DOCX generated at ${outPath}`);
}

build().catch(console.error);