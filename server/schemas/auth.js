import { z } from 'zod';

export const loginSchema = z.object({
  pin: z.string().min(4).max(10),
});
