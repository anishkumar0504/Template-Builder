import { z } from 'zod';
const bbox = z.array(z.number()).length(4);
export const SectionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string(), type: z.enum(['text','rich_text','steps','table','image','code','title','metadata']),
  proof: z.enum(['required','optional','none']).default('optional'), required: z.boolean().default(false), description: z.string().optional(), confidence: z.number().min(0).max(1).default(0.5)
});
export const TemplateSpecSchema = z.object({
  schema_version: z.string().default('1.0.0'), template_name: z.string(), source_file: z.string(), language: z.string().default('unknown'),
  page: z.object({size_name:z.string().nullable().default(null),width_pt:z.number(),height_pt:z.number(),margins_pt:z.object({top:z.number().nullable(),right:z.number().nullable(),bottom:z.number().nullable(),left:z.number().nullable()}),orientation:z.enum(['portrait','landscape','unknown']).default('unknown')}),
  page_border: z.object({present:z.boolean(),color:z.string().nullable(),width_pt:z.number().nullable(),inset_pt:z.array(z.number()).length(4).nullable(),confidence:z.number().min(0).max(1)}),
  header: z.object({present:z.boolean(),elements:z.array(z.object({kind:z.string(),text:z.string().nullable(),asset:z.string().nullable(),bbox_pt:bbox.nullable(),style:z.record(z.string(),z.any()).default({})}))}),
  footer: z.object({present:z.boolean(),elements:z.array(z.object({kind:z.string(),text:z.string().nullable(),asset:z.string().nullable(),bbox_pt:bbox.nullable(),style:z.record(z.string(),z.any()).default({})}))}),
  styles: z.record(z.string(),z.object({font_family:z.string().nullable(),font_size_pt:z.number().nullable(),bold:z.boolean().nullable(),italic:z.boolean().nullable(),color:z.string().nullable(),alignment:z.string().nullable().default(null)})),
  fixed_text: z.array(z.string()), variable_fields: z.array(z.object({key:z.string(),label:z.string(),type:z.string(),required:z.boolean().default(false)})),
  sections: z.array(SectionSchema), layout_elements: z.array(z.object({page:z.number().int().positive(),kind:z.string(),bbox_pt:bbox, text:z.string().nullable(),asset:z.string().nullable(),style:z.record(z.string(),z.any()).default({}),confidence:z.number().min(0).max(1)})),
  page_variants: z.array(z.object({page_numbers:z.array(z.number().int().positive()),kind:z.string(),notes:z.string()})).default([]), assets: z.array(z.object({file:z.string(),purpose:z.string(),page:z.number().int().positive().nullable().default(null)})).default([]), warnings:z.array(z.string()).default([]), needs_human_review:z.boolean().default(true)
});
