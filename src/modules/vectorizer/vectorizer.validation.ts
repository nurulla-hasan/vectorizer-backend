import { z } from 'zod';

export const vectorSettingsSchema = z.object({
  colorPrecision: z.coerce.number().int().min(1).max(8).default(6),
  filterSpeckle: z.coerce.number().int().min(0).max(64).default(12),
  cornerThreshold: z.coerce.number().min(0).max(180).default(70),
  mode: z.enum(['spline', 'polygon', 'pixel']).default('spline'),
  hierarchical: z.enum(['stacked', 'cutout']).default('stacked'),
  maxColors: z.coerce.number().int().min(2).max(64).default(6),
});

export const vectorJobIdSchema = z.string().uuid('Invalid vector job ID');

export const processVectorSchema = vectorSettingsSchema.partial();
export const reprocessVectorSchema = vectorSettingsSchema.partial();

const editedSvgSchema = z
  .string()
  .min(1)
  .max(8_000_000)
  .refine((svg) => /^<svg[\s>]/i.test(svg.trim()), 'Expected an SVG document')
  .refine((svg) => !/<script\b/i.test(svg), 'Scripts are not allowed in edited SVG')
  .refine(
    (svg) => !/<foreignObject\b/i.test(svg),
    'foreignObject is not allowed in edited SVG',
  )
  .refine(
    (svg) => !/\bon\w+\s*=/i.test(svg),
    'Event handler attributes are not allowed in edited SVG',
  );

export const saveEditedSvgSchema = z.object({ svg: editedSvgSchema });

export const exportQuerySchema = z.object({
  format: z.enum(['svg', 'png', 'pdf']).default('svg'),
  scale: z.coerce
    .number()
    .int()
    .refine((v) => v === 1 || v === 2 || v === 4, {
      message: 'Scale must be 1, 2, or 4',
    })
    .default(2),
});

export type VectorSettings = z.infer<typeof vectorSettingsSchema>;
export type ExportFormat = z.infer<typeof exportQuerySchema>['format'];
