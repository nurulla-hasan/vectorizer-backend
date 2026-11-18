import { z } from 'zod';

export const vectorSettingsSchema = z.object({
  filterSpeckle: z.coerce.number().int().min(0).max(64).default(12),
  mode: z.enum(['spline', 'polygon', 'pixel']).default('spline'),
  hierarchical: z.enum(['stacked', 'cutout']).default('cutout'),
  maxColors: z.coerce.number().int().min(2).max(64).default(24),
  removeBackground: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1')
    .default(false),
  backgroundTolerance: z.coerce.number().int().min(0).max(128).default(64),
});

export const vectorJobIdSchema = z.string().uuid('Invalid vector job ID');

export const processVectorSchema = vectorSettingsSchema.partial();
export const reprocessVectorSchema = vectorSettingsSchema.partial();

export const importUrlSchema = vectorSettingsSchema.partial().extend({
  url: z.string().trim().min(1, 'Image URL is required').max(4096),
});

const editedSvgSchema = z
  .string()
  .min(1)
  .max(8_000_000)
  .refine((svg) => /^<svg[\s>]/i.test(svg.trim()), 'Expected an SVG document')
  .refine((svg) => !/<script\b/i.test(svg), 'Scripts are not allowed in edited SVG')
  .refine((svg) => !/<foreignObject\b/i.test(svg), 'foreignObject is not allowed in edited SVG')
  .refine(
    (svg) => !/\bon\w+\s*=/i.test(svg),
    'Event handler attributes are not allowed in edited SVG',
  );

export const saveEditedSvgSchema = z.object({ svg: editedSvgSchema });

export const exportQuerySchema = z.object({
  format: z.enum(['svg', 'png', 'pdf', 'eps', 'dxf']).default('svg'),
  scale: z.coerce
    .number()
    .int()
    .refine((v) => v === 1 || v === 2 || v === 4, {
      message: 'Scale must be 1, 2, or 4',
    })
    .default(2),
  preset: z.enum(['general', 'editing', 'cutting']).default('general'),
});

export type VectorSettings = z.infer<typeof vectorSettingsSchema>;
export type ExportFormat = z.infer<typeof exportQuerySchema>['format'];
export type ExportStyle = z.infer<typeof exportQuerySchema>['preset'];
