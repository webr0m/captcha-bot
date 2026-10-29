/** Defaults apply only when an administrator has not chosen a value. */
export const DEFAULT_CAPTCHA_MODE = "turnstile";
export function captchaEnabledByDefault(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === "true";
}
export const DEFAULT_GROUP_SETTINGS: Record<string, string> = {
  captcha_enabled: "true", captcha_mode: DEFAULT_CAPTCHA_MODE,
  adm_report: "true", delete_bot_messages: "true", delete_service_messages: "true",
  cas_enabled: "true", antiflood_enabled: "true", antilink_enabled: "true",
};
