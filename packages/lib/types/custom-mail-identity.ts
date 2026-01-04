import { z } from 'zod';

// Accept either a single email or multiple emails separated by ';'.
// Keep this schema free of ZodEffects (transform/refine) so OpenAPI generation works.
const EMAIL_PART = '[^\\s;@]+@[^\\s;@]+\\.[^\\s;@]+';
const SEMICOLON_SEPARATED_EMAILS_REGEX = new RegExp(
  `^\\s*${EMAIL_PART}(?:\\s*;\\s*${EMAIL_PART})*\\s*$`,
);

export const ZCustomMailIdentitySchema = z
  .object({
    email: z
      .string()
      .regex(SEMICOLON_SEPARATED_EMAILS_REGEX, 'Invalid email address')
      .describe('Email address for the custom mail identity'),
    name: z.string().min(1, 'Name is required').describe('Name for the custom mail identity'),
    logo: z.string().url().nullish().describe('URL to the logo image for the custom mail identity'),
  })
  .nullish();

export type TCustomMailIdentity = z.infer<typeof ZCustomMailIdentitySchema>;
