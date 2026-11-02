/** The owner confirms site approval; unknown consent environments fail closed. */
export interface AdSenseEnv {
  ADSENSE_SITE_APPROVED?: string;
}
const CONSENT_REGIONS = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IS",
  "IE",
  "IT",
  "LV",
  "LI",
  "LT",
  "LU",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "GB",
  "CH",
]);
export function adsenseAllowedForRequest(
  env: AdSenseEnv,
  country?: string,
  hostname?: string,
): boolean {
  return (
    env.ADSENSE_SITE_APPROVED === "true" &&
    ["webrom.cc", "verify.webrom.cc"].includes(hostname || "") &&
    /^[A-Z]{2}$/.test(country || "") &&
    !["XX", "ZZ", "EU", "UK"].includes(country!) &&
    !CONSENT_REGIONS.has(country!)
  );
}
