import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import { TemplateSpecSchema } from './schema.js';
const spawnAsync = (cmd,args,opts={}) => new Promise((resolve,reject)=>{
  const child=spawn(cmd,args,{stdio:['ignore','pipe','pipe'],...opts}); let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
  child.on('error',reject); child.on('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(`${cmd} exited ${code}: ${stderr||stdout}`)));
});
export async function extractPdf(pdfPath, jobDir) {
  const extractor=path.resolve('python/extract_pdf.py');
  // Prefer the project's venv so requirements installed there are always used.
  const venvPython = process.platform === 'win32'
    ? path.resolve('.venv/Scripts/python.exe')
    : path.resolve('.venv/bin/python');
  let python = process.env.PYTHON;
  if (!python) {
    try { await fs.access(venvPython); python = venvPython; }
    catch { python = process.platform === 'win32' ? 'python' : 'python3'; }
  }
  await spawnAsync(python,[extractor,'--pdf',path.resolve(pdfPath),'--out',path.resolve(jobDir)],{cwd:process.cwd()});
  return JSON.parse(await fs.readFile(path.join(jobDir,'extraction.json'),'utf8'));
}
function responseSchema() {
  return {type:'OBJECT',properties:{
    schema_version:{type:'STRING'},template_name:{type:'STRING'},source_file:{type:'STRING'},language:{type:'STRING'},
    page:{type:'OBJECT',properties:{size_name:{type:'STRING',nullable:true},width_pt:{type:'NUMBER'},height_pt:{type:'NUMBER'},margins_pt:{type:'OBJECT',properties:{top:{type:'NUMBER',nullable:true},right:{type:'NUMBER',nullable:true},bottom:{type:'NUMBER',nullable:true},left:{type:'NUMBER',nullable:true}},required:['top','right','bottom','left']},orientation:{type:'STRING',enum:['portrait','landscape','unknown']}},required:['width_pt','height_pt','margins_pt','orientation']},
    page_border:{type:'OBJECT',properties:{present:{type:'BOOLEAN'},color:{type:'STRING',nullable:true},width_pt:{type:'NUMBER',nullable:true},inset_pt:{type:'ARRAY',items:{type:'NUMBER'},nullable:true},confidence:{type:'NUMBER'}},required:['present','confidence']},
    header:{type:'OBJECT',properties:{present:{type:'BOOLEAN'},elements:{type:'ARRAY',items:{type:'OBJECT',properties:{kind:{type:'STRING'},text:{type:'STRING',nullable:true},asset:{type:'STRING',nullable:true},bbox_pt:{type:'ARRAY',items:{type:'NUMBER'},nullable:true},style:{type:'OBJECT'}},required:['kind','text','asset','style']}}},required:['present','elements']},
    footer:{type:'OBJECT',properties:{present:{type:'BOOLEAN'},elements:{type:'ARRAY',items:{type:'OBJECT',properties:{kind:{type:'STRING'},text:{type:'STRING',nullable:true},asset:{type:'STRING',nullable:true},bbox_pt:{type:'ARRAY',items:{type:'NUMBER'},nullable:true},style:{type:'OBJECT'}},required:['kind','text','asset','style']}}},required:['present','elements']},
    styles:{type:'OBJECT',additionalProperties:{type:'OBJECT',properties:{font_family:{type:'STRING',nullable:true},font_size_pt:{type:'NUMBER',nullable:true},bold:{type:'BOOLEAN',nullable:true},italic:{type:'BOOLEAN',nullable:true},color:{type:'STRING',nullable:true},alignment:{type:'STRING',nullable:true}},required:['font_family','font_size_pt','bold','italic','color']}},
    fixed_text:{type:'ARRAY',items:{type:'STRING'}},variable_fields:{type:'ARRAY',items:{type:'OBJECT',properties:{key:{type:'STRING'},label:{type:'STRING'},type:{type:'STRING'},required:{type:'BOOLEAN'}},required:['key','label','type','required']}},
    sections:{type:'ARRAY',items:{type:'OBJECT',properties:{key:{type:'STRING'},label:{type:'STRING'},type:{type:'STRING',enum:['text','rich_text','steps','table','image','code','title','metadata']},proof:{type:'STRING',enum:['required','optional','none']},required:{type:'BOOLEAN'},description:{type:'STRING'},confidence:{type:'NUMBER'}},required:['key','label','type','proof','required','confidence']}},
    layout_elements:{type:'ARRAY',items:{type:'OBJECT',properties:{page:{type:'INTEGER'},kind:{type:'STRING'},bbox_pt:{type:'ARRAY',items:{type:'NUMBER'}},text:{type:'STRING',nullable:true},asset:{type:'STRING',nullable:true},style:{type:'OBJECT'},confidence:{type:'NUMBER'}},required:['page','kind','bbox_pt','text','asset','style','confidence']}},
    page_variants:{type:'ARRAY',items:{type:'OBJECT',properties:{page_numbers:{type:'ARRAY',items:{type:'INTEGER'}},kind:{type:'STRING'},notes:{type:'STRING'}},required:['page_numbers','kind','notes']}},assets:{type:'ARRAY',items:{type:'OBJECT',properties:{file:{type:'STRING'},purpose:{type:'STRING'},page:{type:'INTEGER',nullable:true}},required:['file','purpose']}},warnings:{type:'ARRAY',items:{type:'STRING'}},needs_human_review:{type:'BOOLEAN'}
  },required:['template_name','source_file','page','page_border','header','footer','styles','fixed_text','variable_fields','sections','layout_elements','warnings','needs_human_review']};
}
export async function analyzeTemplate(extraction, jobDir) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing. Copy .env.example to .env and add your key.');
  const ai = new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
  const prompt = await fs.readFile(path.resolve('prompts/template-analysis.md'),'utf8');
  const pageImages=[];
  // Send first, middle and last pages to control token/cost use; all page measurements remain available in JSON.
  const indexes=[...new Set([0,Math.floor((extraction.pages.length-1)/2),extraction.pages.length-1])].filter(i=>i>=0);
  for (const i of indexes) {
    const file=path.join(jobDir,extraction.pages[i].preview);
    const b64=(await fs.readFile(file)).toString('base64');
    pageImages.push({inlineData:{mimeType:'image/png',data:b64}});
  }
  
  const compact = {
    source_file: extraction.source_file,
    page_count: extraction.page_count,
    metadata: extraction.metadata,
    assets: extraction.assets,
    original_embedded_images: extraction.original_embedded_images ?? [],
    pages: extraction.pages.map((p, index) => ({
      page: p.page ?? p.page_number ?? index + 1,
      width_pt: p.width_pt ?? p.page_width_pt ?? null,
      height_pt: p.height_pt ?? p.page_height_pt ?? null,
      rotation: p.rotation ?? 0,
      has_text_layer: p.has_text_layer ?? true,

      // Support both the older and newer extractor formats.
      text: p.text ??
        (p.text_lines ?? [])
          .map(line => line.text ?? "")
          .join("\n"),

      text_lines: p.text_lines ?? [],
      words: p.words ?? [],
      blocks: p.blocks ?? [],
      drawings: p.drawings ?? [],
      images: p.images ?? [],
      preview: p.preview ?? null,
    })),
  };

  const response=await ai.models.generateContent({model:process.env.GEMINI_MODEL||'gemini-2.5-flash',contents:[{role:'user',parts:[{text:prompt+'\n\nEXTRACTED MEASUREMENTS JSON (authoritative for geometry):\n'+JSON.stringify(compact)},...pageImages]}],config:{responseMimeType:'application/json',responseSchema:responseSchema(),temperature:0.1}});
  let parsed; try { parsed=JSON.parse(response.text); } catch { throw new Error('Gemini did not return valid JSON. Raw response saved for debugging.'); }
  parsed.source_file=extraction.source_file;
  // Include extracted assets without allowing model paths to escape the job folder.
  parsed.assets=(parsed.assets||[]).map(a=>({...a,file:String(a.file||'').replace(/^\/+/, '')}));
  const validated=TemplateSpecSchema.safeParse(parsed);
  if(!validated.success) {
    await fs.writeFile(path.join(jobDir,'gemini-invalid-response.json'),JSON.stringify({parsed,issues:validated.error.issues},null,2));
    throw new Error('Gemini template spec failed validation; see gemini-invalid-response.json. '+validated.error.issues.slice(0,4).map(i=>`${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const spec=validated.data;
  const measuredPages=extraction.pages;
  if(spec.page.width_pt===undefined) spec.page.width_pt=measuredPages[0].width_pt;
  if(spec.page.height_pt===undefined) spec.page.height_pt=measuredPages[0].height_pt;
  spec.warnings=[...new Set([...(spec.warnings||[]),...extraction.notes])];
  await fs.writeFile(path.join(jobDir,'template-spec.json'),JSON.stringify(spec,null,2));
  return spec;
}
export async function runTemplatePipeline(pdfPath, outputRoot) {
  const base=path.basename(pdfPath,path.extname(pdfPath)).replace(/[^a-zA-Z0-9_-]/g,'_');
  const jobDir=path.join(outputRoot,`${base}-${Date.now()}`);
  await fs.mkdir(jobDir,{recursive:true});
  const extraction=await extractPdf(pdfPath,jobDir);
  const spec=await analyzeTemplate(extraction,jobDir);
  return {jobDir,extraction,spec};
}
