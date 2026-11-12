import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod/v4";
import {
  db,
  organizationsTable,
} from "@workspace/db";
import {
  ExtractBrandingBody,
  ExtractBrandingResponse,
  GetBrandingResponse,
  ImportBrandingLogoBody,
  ImportBrandingLogoResponse,
  ResetBrandingResponse,
  StageBrandingLogoBody,
  StageBrandingLogoResponse,
  UpdateBrandingBody,
  UpdateBrandingResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  ObjectAccessGroupType,
  ObjectPermission,
  getObjectAclPolicy,
} from "../lib/objectAcl";
import { validateAndScanImage } from "../lib/file-scan";
import { logAdminEvent, logUploadRejected } from "../lib/security-log";
import { requireRole } from "../middleware/auth";
import {
  BRAND_DEFAULTS,
  brandingLogoRevision,
  isBrandingObjectPath,
  isBrandingLogoRevision,
  isObjectEntityPath,
  publicBrandLogoUrl,
  toBrand,
  type BrandLogoVariant,
} from "../lib/branding";
import {
  BrandingFetchError,
  extractBranding,
  fetchPublicResource,
  MAX_BRANDING_IMAGE_BYTES,
} from "../lib/branding-extractor";

const router: IRouter = Router();
const storageService = new ObjectStorageService();
const ALLOWED_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BASE64_LENGTH = Math.ceil((MAX_BRANDING_IMAGE_BYTES * 4) / 3) + 8;
const MAX_BRANDING_IMAGE_PIXELS = 25_000_000;
const MAX_BRANDING_IMAGE_DIMENSION = 8_192;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const PREVIEW_PREFIX = "/api/branding/logo/preview/";

const BrandSchema = z.object({
  displayName: z.string().trim().max(200).nullable(),
  websiteUrl: z.string().trim().max(2048).nullable(),
  primaryColor: z.string().regex(HEX_COLOR, "Must be a valid hexadecimal color").nullable(),
  accentColor: z.string().regex(HEX_COLOR, "Must be a valid hexadecimal color").nullable(),
  backgroundColor: z.string().regex(HEX_COLOR, "Must be a valid hexadecimal color").nullable(),
  logoUrl: z.string().trim().max(4096).nullable(),
  logoDarkUrl: z.string().trim().max(4096).nullable(),
});

const LogoUploadSchema = z.object({
  data: z.string().min(1).max(MAX_BASE64_LENGTH),
  contentType: z.string().trim().toLowerCase().refine((value) => ALLOWED_LOGO_TYPES.has(value), {
    message: "Only JPEG, PNG, WebP, and GIF logos are allowed",
  }),
});

function errorMessage(error: unknown, fallback: string): { status: number; error: string } {
  if (error instanceof BrandingFetchError) {
    return { status: error.statusCode, error: error.message };
  }
  if (error instanceof ObjectNotFoundError) {
    return { status: 404, error: "Logo not found" };
  }
  return { status: 500, error: fallback };
}

function sendError(res: Response, error: unknown, fallback: string): void {
  const result = errorMessage(error, fallback);
  res.status(result.status).json({ error: result.error });
}

function validateWebsiteUrl(value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrandingFetchError("Website URL must be a valid HTTP or HTTPS URL", 400);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new BrandingFetchError("Website URL must be a valid HTTP or HTTPS URL", 400);
  }
  return url.toString();
}

function encodePreviewToken(objectPath: string): string {
  return Buffer.from(objectPath, "utf8").toString("base64url");
}

function decodePreviewToken(token: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new BrandingFetchError("Invalid logo preview URL", 400);
  }
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new BrandingFetchError("Invalid logo preview URL", 400);
  }
  if (!isObjectEntityPath(decoded)) {
    throw new BrandingFetchError("Invalid logo preview URL", 400);
  }
  return decoded;
}

function parsePreviewUrl(value: string): string | null {
  if (!value.startsWith(PREVIEW_PREFIX)) return null;
  const token = value.slice(PREVIEW_PREFIX.length);
  if (!token || token.includes("/")) {
    throw new BrandingFetchError("Invalid logo preview URL", 400);
  }
  return decodePreviewToken(token);
}

function decodeBase64(data: string): Buffer {
  const normalized = data.replace(/\s+/g, "");
  if (
    normalized.startsWith("data:") ||
    normalized.length > MAX_BASE64_LENGTH ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(normalized)
  ) {
    throw new BrandingFetchError("Logo data must be valid base64 raster image data", 400);
  }
  const standard = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(standard, "base64");
  if (buffer.length === 0 || buffer.length > MAX_BRANDING_IMAGE_BYTES) {
    throw new BrandingFetchError("Logo file is empty or too large", 413);
  }
  return buffer;
}

async function setPrivateLogoAcl(objectPath: string, req: Request): Promise<void> {
  const organizationId = req.user!.organizationId;
  await storageService.trySetObjectEntityAclPolicy(objectPath, {
    owner: req.user!.id,
    visibility: "private",
    aclRules: [
      {
        group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: organizationId },
        permission: ObjectPermission.READ,
      },
    ],
  });
}

async function stageLogo(
  req: Request,
  buffer: Buffer,
  contentType: string,
): Promise<{ logoUrl: string }> {
  const organizationId = req.user!.organizationId;
  const uploadUrl = await storageService.getBrandingLogoUploadURL(organizationId);
  const objectPath = storageService.normalizeObjectEntityPath(uploadUrl);
  if (!isBrandingObjectPath(objectPath, organizationId)) {
    throw new Error("Object storage returned an invalid logo path");
  }
  try {
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: buffer,
    });
    if (!uploadResponse.ok) {
      throw new Error("Object storage rejected the logo");
    }
    await setPrivateLogoAcl(objectPath, req);
    await storageService.setBrandingLogoMetadata(objectPath, organizationId);
    return { logoUrl: `${PREVIEW_PREFIX}${encodePreviewToken(objectPath)}` };
  } catch (error) {
    await storageService.deleteObjectEntity(objectPath).catch(() => {});
    throw error;
  }
}

async function validateLogoBuffer(
  req: Request,
  buffer: Buffer,
  declaredContentType?: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  // The base64/uploaded bytes are untrusted. Do not pass the client-declared
  // MIME to validateAndScanImage; magic bytes are the authority.
  const scan = validateAndScanImage({
    buffer,
    maxBytes: MAX_BRANDING_IMAGE_BYTES,
  });
  if (!scan.ok) {
    logUploadRejected(req, scan.error).catch(() => {});
    throw new BrandingFetchError(scan.error, scan.status);
  }
  if (declaredContentType && scan.contentType !== declaredContentType) {
    const error = "Logo file contents do not match the declared content type";
    logUploadRejected(req, error).catch(() => {});
    throw new BrandingFetchError(error, 400);
  }

  // file-scan intentionally performs only cheap signature/content checks. A
  // branding logo is decoded and re-encoded separately so truncated images,
  // decompression bombs, malformed chunks, and metadata/polyglots cannot reach
  // object storage. libvips applies the pixel limit before allocating pixels.
  try {
    const decoded = sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_BRANDING_IMAGE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoded.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_BRANDING_IMAGE_DIMENSION ||
      metadata.height > MAX_BRANDING_IMAGE_DIMENSION ||
      metadata.width * metadata.height > MAX_BRANDING_IMAGE_PIXELS
    ) {
      throw new BrandingFetchError(
        `Logo dimensions exceed the ${MAX_BRANDING_IMAGE_DIMENSION}px or ${MAX_BRANDING_IMAGE_PIXELS}-pixel limit`,
        413,
      );
    }

    // Re-encoding to PNG strips source metadata and any appended/polyglot
    // payload while retaining the decoded raster pixels.
    const safePng = await decoded.rotate().png({ compressionLevel: 9 }).toBuffer();
    if (safePng.length > MAX_BRANDING_IMAGE_BYTES) {
      throw new BrandingFetchError("Decoded logo is too large", 413);
    }
    return { buffer: safePng, contentType: "image/png" };
  } catch (error) {
    if (error instanceof BrandingFetchError) throw error;
    logUploadRejected(req, "Malformed or truncated raster image").catch(() => {});
    throw new BrandingFetchError("Logo image is malformed or truncated", 400);
  }
}

async function getTrustedBrandingLogoFile(
  objectPath: string,
  organizationId?: string,
): Promise<Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>> | null> {
  if (!isBrandingObjectPath(objectPath, organizationId)) return null;
  let objectFile: Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
  try {
    objectFile = await storageService.getObjectEntityFile(objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return null;
    throw error;
  }
  const [metadata] = await objectFile.getMetadata();
  const customMetadata = metadata.metadata ?? {};
  if (
    metadata.contentType !== "image/png" ||
    customMetadata["branding-logo"] !== "route-branding-v1" ||
    !customMetadata["branding-organization-id"] ||
    (organizationId &&
      customMetadata["branding-organization-id"] !== organizationId) ||
    customMetadata["branding-normalized-content-type"] !== "image/png"
  ) {
    return null;
  }
  return objectFile;
}

async function getOrganization(req: Request) {
  const [organization] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.id, req.user!.organizationId))
    .limit(1);
  return organization ?? null;
}

async function resolveLogoInput(
  req: Request,
  organization: typeof organizationsTable.$inferSelect,
  value: string | null,
  variant: BrandLogoVariant,
): Promise<string | null> {
  if (value === null) return null;
  const storedValue = variant === "light" ? organization.brandLogoUrl : organization.brandLogoDarkUrl;
  const publicUrl = storedValue && isObjectEntityPath(storedValue)
    ? publicBrandLogoUrl(organization.id, variant, brandingLogoRevision(storedValue))
    : null;
  if (value === publicUrl) {
    if (!storedValue) {
      throw new BrandingFetchError("Selected logo is no longer available", 400);
    }
    if (isObjectEntityPath(storedValue)) {
      const objectFile = await getTrustedBrandingLogoFile(storedValue, organization.id);
      if (!objectFile) {
        throw new BrandingFetchError("Selected logo is no longer available", 400);
      }
    }
    return storedValue;
  }

  // Preserve a legacy externally-hosted value only when it is unchanged. New
  // branding selections must use our controlled storage route.
  if (storedValue && storedValue === value && !isObjectEntityPath(storedValue)) {
    return storedValue;
  }

  const objectPath = parsePreviewUrl(value);
  if (!objectPath) {
    throw new BrandingFetchError("Logo must be an uploaded preview or saved branding logo", 400);
  }
  const objectFile = await getTrustedBrandingLogoFile(objectPath, req.user!.organizationId);
  if (!objectFile) {
    throw new BrandingFetchError("Logo must be a staged branding image", 400);
  }
  const canRead = await storageService.canAccessObjectEntity({
    authenticatedOrganizationId: req.user!.organizationId,
    workspaceOrganizationId: req.user!.workspace?.organizationId,
    userId: req.user!.id,
    objectFile,
    requestedPermission: ObjectPermission.READ,
  });
  if (!canRead) {
    throw new BrandingFetchError("Logo does not belong to this organization", 403);
  }
  return objectPath;
}

async function publishLogo(req: Request, objectPath: string | null): Promise<void> {
  if (!objectPath || !isObjectEntityPath(objectPath)) return;
  const organizationId = req.user!.organizationId;
  await storageService.trySetObjectEntityAclPolicy(objectPath, {
    owner: req.user!.id,
    // The object remains private in the generic storage route. Anonymous
    // access is granted only by /branding/public after the selected DB field
    // has been checked.
    visibility: "private",
    aclRules: [
      {
        group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: organizationId },
        permission: ObjectPermission.READ,
      },
    ],
  });
}

async function serveLogo(
  req: Request,
  res: Response,
  objectPath: string,
  requirePublic: boolean,
  organizationId?: string,
): Promise<void> {
  const trustedOrganizationId = organizationId ?? req.user?.organizationId;
  const objectFile = await getTrustedBrandingLogoFile(objectPath, trustedOrganizationId);
  if (!objectFile) {
    const status = !requirePublic && req.user && isBrandingObjectPath(objectPath)
      ? 403
      : 404;
    res.status(status).json({ error: status === 403 ? "Forbidden" : "Logo not found" });
    return;
  }
  if (requirePublic) {
    const policy = await getObjectAclPolicy(objectFile);
    const belongsToOrganization =
      !organizationId ||
      policy?.aclRules?.some(
        (rule) =>
          rule.group.type === ObjectAccessGroupType.ORG_MEMBERS &&
          rule.group.id === organizationId,
      );
    if (!policy || !belongsToOrganization) {
      res.status(404).json({ error: "Logo not found" });
      return;
    }
  } else {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const canRead = await storageService.canAccessObjectEntity({
      authenticatedOrganizationId: req.user!.organizationId,
      workspaceOrganizationId: req.user!.workspace?.organizationId,
      userId: req.user.id,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });
    if (!canRead) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  const response = await storageService.downloadObject(objectFile);
  res.status(response.status);
  response.headers.forEach((headerValue, headerName) => res.setHeader(headerName, headerValue));
  if (!requirePublic) res.setHeader("Cache-Control", "no-store");
  if (requirePublic) {
    res.setHeader("Cache-Control", "no-store");
  }
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:");
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    res.end(Buffer.concat(chunks));
    return;
  }
  res.end();
}

router.get("/branding", async (req, res): Promise<void> => {
  try {
    const organization = await getOrganization(req);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    // Workspace identity always belongs to the authenticated organization,
    // including customers that have not configured optional branding yet.
    res.json(GetBrandingResponse.parse({ ...toBrand(organization), displayName: organization.brandDisplayName || organization.name }));
  } catch (error) {
    sendError(res, error, "Failed to load branding");
  }
});

router.put("/branding", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const generated = UpdateBrandingBody.safeParse(req.body);
    const parsed = generated.success ? BrandSchema.safeParse(generated.data) : generated;
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid branding settings" });
      return;
    }
    const organization = await getOrganization(req);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const websiteUrl = validateWebsiteUrl(parsed.data.websiteUrl);
    const logoPath = await resolveLogoInput(req, organization, parsed.data.logoUrl, "light");
    const logoDarkPath = await resolveLogoInput(req, organization, parsed.data.logoDarkUrl, "dark");
    await publishLogo(req, logoPath);
    await publishLogo(req, logoDarkPath);

    const [updated] = await db
      .update(organizationsTable)
      .set({
        brandDisplayName: parsed.data.displayName,
        brandWebsiteUrl: websiteUrl,
        brandPrimaryColor: parsed.data.primaryColor,
        brandAccentColor: parsed.data.accentColor,
        brandBackgroundColor: parsed.data.backgroundColor,
        brandLogoUrl: logoPath,
        brandLogoDarkUrl: logoDarkPath,
      })
      .where(eq(organizationsTable.id, organization.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await logAdminEvent({
      req,
      action: "org.branding_update",
      resourceType: "organization",
      resourceId: organization.id,
      statusCode: 200,
      diff: {
        fields: [
          "brandDisplayName",
          "brandWebsiteUrl",
          "brandPrimaryColor",
          "brandAccentColor",
          "brandBackgroundColor",
          "brandLogoUrl",
          "brandLogoDarkUrl",
        ],
      },
    });
    res.json(UpdateBrandingResponse.parse(toBrand(updated)));
  } catch (error) {
    sendError(res, error, "Failed to save branding");
  }
});

router.delete("/branding", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const organization = await getOrganization(req);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const [updated] = await db
      .update(organizationsTable)
      .set({
        brandDisplayName: null,
        brandWebsiteUrl: null,
        brandPrimaryColor: null,
        brandAccentColor: null,
        brandBackgroundColor: null,
        brandLogoUrl: null,
        brandLogoDarkUrl: null,
        brandTagline: null,
      })
      .where(eq(organizationsTable.id, organization.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await logAdminEvent({
      req,
      action: "org.branding_reset",
      resourceType: "organization",
      resourceId: organization.id,
      statusCode: 200,
      diff: { reset: true },
    });
    res.json(ResetBrandingResponse.parse(BRAND_DEFAULTS));
  } catch (error) {
    sendError(res, error, "Failed to reset branding");
  }
});

router.post("/branding/logo", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const generated = StageBrandingLogoBody.safeParse(req.body);
    const parsed = generated.success ? LogoUploadSchema.safeParse(generated.data) : generated;
    if (!parsed.success) {
      res.status(400).json({ error: "Logo data and a supported content type are required" });
      return;
    }
    const buffer = decodeBase64(parsed.data.data);
    const validated = await validateLogoBuffer(req, buffer, parsed.data.contentType);
    res.json(StageBrandingLogoResponse.parse(await stageLogo(req, validated.buffer, validated.contentType)));
  } catch (error) {
    sendError(res, error, "Failed to stage logo");
  }
});

router.post("/branding/logo/import", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const parsed = ImportBrandingLogoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A valid logo URL is required" });
      return;
    }
    const resource = await fetchPublicResource(parsed.data.url, {
      maxBytes: MAX_BRANDING_IMAGE_BYTES,
      acceptedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    });
    const validated = await validateLogoBuffer(req, resource.body, resource.contentType);
    res.json(ImportBrandingLogoResponse.parse(await stageLogo(req, validated.buffer, validated.contentType)));
  } catch (error) {
    sendError(res, error, "Failed to import logo");
  }
});

router.post("/branding/extract", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const parsed = ExtractBrandingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A valid source URL is required" });
      return;
    }
    res.json(ExtractBrandingResponse.parse(await extractBranding(parsed.data.url)));
  } catch (error) {
    sendError(res, error, "Failed to extract branding");
  }
});

router.get("/branding/logo/preview/:token", async (req, res): Promise<void> => {
  try {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    await serveLogo(req, res, decodePreviewToken(token), false);
  } catch (error) {
    sendError(res, error, "Failed to serve logo preview");
  }
});

router.get("/branding/public/:organizationId/:variant", async (req, res): Promise<void> => {
  try {
    const organizationId = Array.isArray(req.params.organizationId)
      ? req.params.organizationId[0]
      : req.params.organizationId;
    const variant = (Array.isArray(req.params.variant) ? req.params.variant[0] : req.params.variant) as BrandLogoVariant;
    if (!/^[0-9a-f-]{36}$/i.test(organizationId) || !["light", "dark"].includes(variant)) {
      res.status(404).json({ error: "Logo not found" });
      return;
    }
    const [organization] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);
    const storedPath = variant === "light" ? organization?.brandLogoUrl : organization?.brandLogoDarkUrl;
    if (!organization || !storedPath || !isObjectEntityPath(storedPath)) {
      res.status(404).json({ error: "Logo not found" });
      return;
    }
    const revisionQuery = req.query.v;
    if (revisionQuery !== undefined) {
      const revision = typeof revisionQuery === "string" ? revisionQuery : null;
      if (
        !revision ||
        !isBrandingLogoRevision(revision) ||
        revision !== brandingLogoRevision(storedPath)
      ) {
        res.status(404).json({ error: "Logo not found" });
        return;
      }
    }
    await serveLogo(req, res, storedPath, true, organizationId);
  } catch (error) {
    sendError(res, error, "Failed to serve public logo");
  }
});

export default router;
