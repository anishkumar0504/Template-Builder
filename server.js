const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

// --- CONFIGURATION ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); // Swap to 'pro' if needed

const INPUT_PDF = process.argv[2];
if (!INPUT_PDF || !fs.existsSync(INPUT_PDF)) {
    console.error("Usage: node server.js <path_to_pdf>");
    process.exit(1);
}

const baseName = path.basename(INPUT_PDF, '.pdf');
const outputDir = path.dirname(INPUT_PDF) || '.';

function runCmd(cmd) {
    console.log(`[CMD] ${cmd}`);
    try {
        return execSync(cmd, { stdio: 'pipe' }).toString().trim();
    } catch (e) {
        console.error(`Command failed: ${cmd}\n${e.stderr ? e.stderr.toString() : e.message}`);
        return null;
    }
}

async function callGemini(textPrompt, imagePaths) {
    const parts = [{ text: textPrompt }];
    if (imagePaths && imagePaths.length > 0) {
        for (const imgPath of imagePaths) {
            if (fs.existsSync(imgPath)) {
                const imgData = fs.readFileSync(imgPath);
                parts.push({
                    inlineData: { data: imgData.toString('base64'), mimeType: "image/png" }
                });
            }
        }
    }

    try {
        const result = await model.generateContent({ contents: [{ role: "user", parts }] });
        let text = result.response.text();
        // Strip markdown formatting if LLM wraps JSON in ```json ... ```
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text);
    } catch (e) {
        console.error("Gemini API error or invalid JSON response:", e.message);
        return null;
    }
}

async function compareImages(img1Path, img2Path, diffPath) {
    try {
        const img1 = PNG.sync.read(fs.readFileSync(img1Path));
        const img2 = PNG.sync.read(fs.readFileSync(img2Path));
        const width = img1.width;
        const height = img1.height;
        
        if (img2.width !== width || img2.height !== height) {
            return { score: 0.0, diffPath: '' };
        }
        
        const diff = new PNG({ width, height });
        const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });
        fs.writeFileSync(diffPath, PNG.sync.write(diff));
        
        const score = 1 - (numDiffPixels / (width * height));
        return { score, diffPath };
    } catch (e) {
        console.error(`Error comparing images: ${e.message}`);
        return { score: 0.0, diffPath: '' };
    }
}

async function main() {
    console.log("=== STEP 1: Inventory & Measure ===");
    runCmd(`python3 extract.py "${INPUT_PDF}"`);
    const extractedJsonPath = `${outputDir}/${baseName}_extracted.json`;
    if (!fs.existsSync(extractedJsonPath)) return;

    console.log("\n=== STEP 2: Render Original PNGs ===");
    runCmd(`pdftoppm -png -r 150 "${INPUT_PDF}" "${outputDir}/${baseName}_orig"`);
    const origPngs = fs.readdirSync(outputDir).filter(f => f.startsWith(`${baseName}_orig-`) && f.endsWith('.png')).sort();

    console.log("\n=== STEP 3: Generate Initial Spec (Gemini) ===");
    const initialPrompt = `You are an expert document layout engine. Analyze this PDF's raw extracted JSON data and its visual rendering (Image 1).
Generate a spec.json for a DOCX generator using the 'docx' npm package. Group characters into logical blocks (headings, paragraphs, tables). Map fonts to standard ones (Arial, Times New Roman). Keep exact sizes (points) and hex colors.
Output STRICTLY this JSON schema:
{
  "pages": [
    {
      "blocks": [
        {
          "type": "paragraph" | "heading" | "table",
          "text": "string",
          "font": "Arial" | "Times New Roman",
          "size": 12, "bold": boolean, "color": "000000", "align": "left",
          "level": 1,
          "rows": [ [ {"text": "cell"} ] ]
        }
      ]
    }
  ]
}
Do not include explanations or markdown.`;

    let spec = await callGemini(initialPrompt, [`${outputDir}/${origPngs[0]}`]);
    if (!spec) return;
    fs.writeFileSync(`${outputDir}/${baseName}_spec.json`, JSON.stringify(spec, null, 2));

    console.log("\n=== STEP 4: Build & Verify Loop ===");
    for (let i = 0; i < 5; i++) {
        console.log(`\n--- Iteration ${i + 1} ---`);
        
        runCmd(`node build.js "${outputDir}/${baseName}_spec.json" "${outputDir}/${baseName}_out.docx"`);
        const docxPath = `${outputDir}/${baseName}_out.docx`;
        if (!fs.existsSync(docxPath)) break;

        // DOCX -> PDF -> PNG
        runCmd(`soffice --headless --convert-to pdf --outdir "${outputDir}" "${docxPath}"`);
        let outPdfPath = `${outputDir}/${baseName}_out.pdf`;
        if (!fs.existsSync(outPdfPath)) {
             const altOutPdf = `${outputDir}/${baseName}_out.docx.pdf`; 
             if (fs.existsSync(altOutPdf)) fs.renameSync(altOutPdf, outPdfPath);
        }

        runCmd(`pdftoppm -png -r 150 "${outPdfPath}" "${outputDir}/${baseName}_out`);
        const outPngs = fs.readdirSync(outputDir).filter(f => f.startsWith(`${baseName}_out-`) && f.endsWith('.png')).sort();

        // Calculate Visual Diff Score
        let totalScore = 0;
        let diffPngs = [];
        for (let p = 0; p < origPngs.length; p++) {
            const { score, diffPath } = await compareImages(
                `${outputDir}/${origPngs[p]}`, 
                `${outputDir}/${outPngs[p] || outPngs[0]}`, 
                `${outputDir}/${baseName}_diff_${i}_${p}.png`
            );
            totalScore += score;
            diffPngs.push(diffPath);
        }
        
        const avgScore = totalScore / origPngs.length;
        console.log(`Iteration ${i + 1} Average Visual Match Score: ${(avgScore * 100).toFixed(2)}%`);

        if (avgScore > 0.95) {
            console.log("Score threshold met (95%). Done!");
            break;
        }

        if (i < 4) {
            console.log("Patching spec with Gemini...");
            const patchPrompt = `You are a layout debugger. You have the Original PDF (Image 1), the Rendered DOCX (Image 2), and a visual Diff (Image 3).
Current spec.json: ${JSON.stringify(spec, null, 2)}
Analyze the diff. Update the spec.json to fix visual discrepancies. Modify sizes, fonts, grouping, or coordinates to match Image 1.
Return ONLY the updated JSON object.`;

            const patchImages = [
                `${outputDir}/${origPngs[0]}`, 
                `${outputDir}/${outPngs[0]}`
            ];
            if (diffPngs[0] && fs.existsSync(diffPngs[0])) patchImages.push(diffPngs[0]);

            const newSpec = await callGemini(patchPrompt, patchImages);
            if (newSpec) {
                spec = newSpec;
                fs.writeFileSync(`${outputDir}/${baseName}_spec.json`, JSON.stringify(spec, null, 2));
            }
        }
    }

    console.log("\n=== PROCESS COMPLETE ===");
    console.log(`Final DOCX: ${outputDir}/${baseName}_out.docx`);
}

main().catch(console.error);