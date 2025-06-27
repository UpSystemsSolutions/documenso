import { z } from 'zod';

export const ZCustomMailIdentitySchema = z
  .object({
    email: z.string().email().describe('Email address for the custom mail identity'),
    name: z.string().min(1, 'Name is required').describe('Name for the custom mail identity'),
    logo: z.string().url().nullish().describe('URL to the logo image for the custom mail identity'),
  })
  .nullish();

export type TCustomMailIdentity = z.infer<typeof ZCustomMailIdentitySchema>;
