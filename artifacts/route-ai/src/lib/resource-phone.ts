export const PHONE_COUNTRIES = [
  { code: "46", label: "🇸🇪 Sverige" },
  { code: "47", label: "🇳🇴 Norge" },
  { code: "45", label: "🇩🇰 Danmark" },
  { code: "358", label: "🇫🇮 Finland" },
  { code: "354", label: "🇮🇸 Island" },
] as const;

export function normalizeResourcePhone(value: string, countryCode = "46"): string {
  const compact = value.replace(/[\s().-]/g, "");
  if (!compact) return "";
  if (compact.startsWith("+")) return compact;
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  if (!countryCode) return compact;
  return `+${countryCode}${compact.replace(/^0/, "")}`;
}

export function phoneCountry(value: string): string {
  const normalized = normalizeResourcePhone(value);
  if (!normalized) return "46";
  return PHONE_COUNTRIES.find(({ code }) => normalized.startsWith(`+${code}`))?.code ?? "other";
}

export function formatResourcePhone(value: string, countryCode = "46"): string {
  const normalized = normalizeResourcePhone(value, countryCode);
  if (/^\+46\d{9}$/.test(normalized)) {
    return normalized.replace(/^\+46(\d{3})(\d{3})(\d{3})$/, "+46 ($1) $2-$3");
  }
  const country = PHONE_COUNTRIES.find(({ code }) => normalized.startsWith(`+${code}`));
  if (!country) return normalized;
  return `+${country.code} ${normalized.slice(country.code.length + 1).replace(/(\d{3})(?=\d)/g, "$1 ").trim()}`;
}
