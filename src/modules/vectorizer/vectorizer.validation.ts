import { z } from 'zod';

export const vectorSettingsSchema = z.object({
  colorPrecision: z.coerce.number().int().min(1).max(8).default(6),
  filterSpeckle: z.coerce.number().int().min(0).max(64).default(4),
  cornerThreshold: z.coerce.number().min(0).max(180).default(60),
  mode: z.enum(['spline', 'polygon', 'pixel']).default('spline'),
  hierarchical: z.enum(['stacked', 'cutout']).default('stacked'),
  maxColors: z.coerce.number().int().min(2).max(64).default(16),
});

export const processVectorSchema = vectorSettingsSchema.partial();
export const reprocessVectorSchema = vectorSettingsSchema.partial();

export type VectorSettings = z.infer<typeof vectorSettingsSchema>;
