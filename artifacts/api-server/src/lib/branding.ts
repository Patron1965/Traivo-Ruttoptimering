import { createHash } from "node:crypto";

export interface Brand {
  displayName: string | null;
  websiteUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  backgroundColor: string | null;
  logoUrl: string | null;
  logoDarkUrl: string | null;
}

export type BrandLogoVariant = "light" | "dark";
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const BRAND_DEFAULTS: Brand = {
  displayName: null,
  websiteUrl: null,
  primaryColor: null,
  accentColor: null,
  backgroundColor: null,
  logoUrl: null,
  logoDarkUrl: null,
};

const BRANDING_LOGO_REVISION_LENGTH = 16;
const BRANDING_LOGO_REVISION_PATTERN = /^[a-f0-9]{16}$/;

export function brandingLogoRevision(storedPath: string): string {
  return createHash("sha256")
    .update(storedPath, "utf8")
    .digest("hex")
    .slice(0, BRANDING_LOGO_REVISION_LENGTH);
}

export function isBrandingLogoRevision(value: string): boolean {
  return BRANDING_LOGO_REVISION_PATTERN.test(value);
}

export function publicBrandLogoUrl(
  organizationId: string,
  variant: BrandLogoVariant,
  revision?: string,
): string {
  const suffix = revision ? `?v=${encodeURIComponent(revision)}` : "";
  return `/api/branding/public/${organizationId}/${variant}${suffix}`;
}

export function isObjectEntityPath(value: string): boolean {
  if (!value.startsWith("/objects/") || value.length <= "/objects/".length) {
    return false;
  }
  const pieces = value.slice("/objects/".length).split("/");
  return pieces.every(
    (piece) =>
      piece.length > 0 &&
      piece !== "." &&
      piece !== ".." &&
      /^[A-Za-z0-9._-]+$/.test(piece),
  );
}

export function isBrandingObjectPath(value: string, organizationId?: string): boolean {
  if (!isObjectEntityPath(value)) return false;
  const pieces = value.slice("/objects/".length).split("/");
  return (
    pieces.length === 3 &&
    pieces[0] === "branding" &&
    (!organizationId || pieces[1] === organizationId)
  );
}

/**
 * Saved object paths are deliberately translated to a route that checks the
 * organization's current selected logo before serving bytes. Legacy branding
 * URLs are retained as-is for backward compatibility.
 */
export function brandLogoResponseUrl(
  organizationId: string,
  variant: BrandLogoVariant,
  storedPath: string | null,
): string | null {
  if (!storedPath) return null;
  return isObjectEntityPath(storedPath)
    ? publicBrandLogoUrl(organizationId, variant, brandingLogoRevision(storedPath))
    : storedPath;
}

export function safeBrandColor(value: string | null): string | null {
  return value && HEX_COLOR.test(value) ? value : null;
}

export function toBrand(
  organization: {
    id: string;
    brandDisplayName: string | null;
    brandWebsiteUrl: string | null;
    brandPrimaryColor: string | null;
    brandAccentColor: string | null;
    brandBackgroundColor: string | null;
    brandLogoUrl: string | null;
    brandLogoDarkUrl: string | null;
  },
): Brand {
  return {
    displayName: organization.brandDisplayName,
    websiteUrl: organization.brandWebsiteUrl,
    primaryColor: safeBrandColor(organization.brandPrimaryColor),
    accentColor: safeBrandColor(organization.brandAccentColor),
    backgroundColor: safeBrandColor(organization.brandBackgroundColor),
    logoUrl: brandLogoResponseUrl(organization.id, "light", organization.brandLogoUrl),
    logoDarkUrl: brandLogoResponseUrl(organization.id, "dark", organization.brandLogoDarkUrl),
  };
}
