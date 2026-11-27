import { z } from 'zod';
export const LOCAL_API_VERSION = 7;
export const LocalVersionSchema = z.literal(LOCAL_API_VERSION);
