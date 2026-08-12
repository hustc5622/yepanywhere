export const AUTH_ERROR_CODES = {
  adminNotConfigured: "AUTH_ADMIN_NOT_CONFIGURED",
  adminInvalid: "AUTH_ADMIN_INVALID",
  loginInvalid: "AUTH_LOGIN_INVALID",
  localRequired: "AUTH_LOCAL_REQUIRED",
  passwordInvalid: "AUTH_PASSWORD_INVALID",
  configError: "AUTH_CONFIG_ERROR",
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
