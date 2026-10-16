import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runTemplatePipeline} from './pipeline.js';
import {generateDocx} from './renderer.js';
const [,,command,arg1,arg2]=process.argv;
const input=path.resolve(process.env.INPUT_DIR||'./input');
const output=path.resolve(process.env.OUTPUT_DIR||'./output');
if(command==='analyze') {
  const file=arg1;
  if(!file) { console.error('Usage: npm run analyze -- ./input/example.pdf'); process.exit(1); }
  const pdf=path.resolve(file);
  const result=await runTemplatePipeline(pdf,output);
  console.log(JSON.stringify({jobDir:result.jobDir,extraction:path.join(result.jobDir,'extraction.json'),spec:path.join(result.jobDir,'template-spec.json'),pages:path.join(result.jobDir,'pages')},null,2));
} else if(command==='generate') {
  const job=arg1, contentFile=arg2;
  if(!job||!contentFile) { console.error('Usage: npm run generate -- ./output/JOB_DIR ./content.json'); process.exit(1); }
  const specPath=path.join(path.resolve(job),'template-spec.json');
  const outputPath=path.join(path.resolve(job),'generated-report.docx');
  console.log(JSON.stringify(await generateDocx({specPath,contentPath:path.resolve(contentFile),outputPath}),null,2));
} else { console.error('Commands: analyze, generate'); process.exit(1); }
