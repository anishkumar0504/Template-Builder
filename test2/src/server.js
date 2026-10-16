import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runTemplatePipeline } from './pipeline.js';
import { generateDocx } from './renderer.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(__dirname,'..');
const inputDir=path.resolve(process.env.INPUT_DIR||path.join(root,'input'));
const outputDir=path.resolve(process.env.OUTPUT_DIR||path.join(root,'output'));
await fs.mkdir(inputDir,{recursive:true}); await fs.mkdir(outputDir,{recursive:true});
const app=express(); app.use(cors()); app.use(express.json({limit:'10mb'}));
const maxMb=Number(process.env.MAX_PDF_MB||40);
const upload=multer({dest:inputDir,limits:{fileSize:maxMb*1024*1024,files:1},fileFilter:(req,file,cb)=>{
  const ok=file.mimetype==='application/pdf'||file.originalname.toLowerCase().endsWith('.pdf');
  cb(ok?null:new Error('Only PDF files are accepted.'),ok);
}});
app.get('/health',(req,res)=>res.json({ok:true,service:'projectx-template-builder',geminiConfigured:Boolean(process.env.GEMINI_API_KEY)}));
app.post('/api/templates/analyze-local',async(req,res)=>{
  try {
    const requested=String(req.body?.file||'');
    if(!requested || path.basename(requested)!==requested || !requested.toLowerCase().endsWith('.pdf')) return res.status(400).json({error:'Pass a PDF filename located directly inside the input directory.'});
    const pdf=path.join(inputDir,requested); await fs.access(pdf);
    const result=await runTemplatePipeline(pdf,outputDir);
    res.json({ok:true,jobDir:result.jobDir,extractionPath:path.join(result.jobDir,'extraction.json'),templateSpecPath:path.join(result.jobDir,'template-spec.json'),pagePreviews:path.join(result.jobDir,'pages'),assetDirectory:path.join(result.jobDir,'assets'),template:result.spec});
  } catch(e) { console.error(e); res.status(500).json({error:e.message}); }
});
app.post('/api/templates/upload-and-analyze',upload.single('pdf'),async(req,res)=>{
  let stored;
  try {
    if(!req.file) return res.status(400).json({error:'Attach one PDF in form field named pdf.'});
    const safe=crypto.randomUUID()+'-'+path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g,'_');
    stored=path.join(inputDir,safe); await fs.rename(req.file.path,stored);
    const result=await runTemplatePipeline(stored,outputDir);
    res.json({ok:true,sourceFile:safe,jobDir:result.jobDir,extractionPath:path.join(result.jobDir,'extraction.json'),templateSpecPath:path.join(result.jobDir,'template-spec.json'),pagePreviews:path.join(result.jobDir,'pages'),assetDirectory:path.join(result.jobDir,'assets'),template:result.spec});
  } catch(e) { console.error(e); res.status(500).json({error:e.message,sourceFile:stored?path.basename(stored):undefined}); }
});
app.get('/api/templates/:job/spec',async(req,res)=>{
  try { const job=path.basename(req.params.job); const file=path.join(outputDir,job,'template-spec.json'); res.json(JSON.parse(await fs.readFile(file,'utf8'))); }
  catch { res.status(404).json({error:'Template spec not found. Use the job folder name returned by analyze.'}); }
});
app.patch('/api/templates/:job/spec',async(req,res)=>{
  try { const job=path.basename(req.params.job); const file=path.join(outputDir,job,'template-spec.json');
    const current=JSON.parse(await fs.readFile(file,'utf8')); const next={...current,...req.body};
    // Revalidate via shared schema to avoid saving malformed section/layout structures.
    const {TemplateSpecSchema}=await import('./schema.js'); const parsed=TemplateSpecSchema.safeParse(next);
    if(!parsed.success) return res.status(400).json({error:'Invalid template spec',issues:parsed.error.issues});
    await fs.writeFile(file,JSON.stringify(parsed.data,null,2)); res.json({ok:true,template:parsed.data});
  } catch(e) { res.status(400).json({error:e.message}); }
});
app.post('/api/templates/:job/generate-docx',async(req,res)=>{
  try {
    const job=path.basename(req.params.job); const jobDir=path.join(outputDir,job);
    const specPath=path.join(jobDir,'template-spec.json');
    const content=req.body?.content;
    if(!content||typeof content!=='object'||Array.isArray(content)) return res.status(400).json({error:'Send JSON body: {"content":{"title":"...","aim":"..."}}'});
    const contentPath=path.join(jobDir,'content.json'); await fs.writeFile(contentPath,JSON.stringify(content,null,2));
    const name=(String(req.body?.filename||'generated-report').replace(/[^a-zA-Z0-9_-]/g,'_'))+'.docx';
    const out=path.join(jobDir,name); await generateDocx({specPath,contentPath,outputPath:out});
    res.download(out);
  } catch(e) { console.error(e); res.status(500).json({error:e.message}); }
});
app.use((err,req,res,next)=>{res.status(err instanceof multer.MulterError?413:400).json({error:err.message||'Request failed'});});
const port=Number(process.env.PORT||8000); app.listen(port,()=>console.log(`ProjectX Template Builder running at http://localhost:${port}`));
