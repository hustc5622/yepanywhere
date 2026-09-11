import { z } from "zod";

export const FeishuUserAuthStatusSchema = z.enum([
  "not_connected",
  "ready",
  "refreshing",
  "retrying",
  "reauth_required",
  "config_error",
  "refresh_uncertain",
]);
export type FeishuUserAuthStatus = z.infer<typeof FeishuUserAuthStatusSchema>;
export interface FeishuUserAuthView {
  accountId: string;
  userOpenId: string;
  status: FeishuUserAuthStatus;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  lastRefreshedAt?: number;
  lastError?: string;
  scopes: string[];
  authorizationUrl?: string;
  authorizationExpiresAt?: number;
}
export const FeishuUserAuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  redirectUri: z.string().url().optional(),
  scopes: z
    .array(z.string().regex(/^[A-Za-z0-9_:.-]+$/))
    .max(190)
    .default([
      "offline_access",
      "contact:user.base:readonly",
      "drive:file:download",
      "space:document:retrieve",
      "drive:drive.metadata:readonly",
      "docx:document:readonly",
    ]),
});
