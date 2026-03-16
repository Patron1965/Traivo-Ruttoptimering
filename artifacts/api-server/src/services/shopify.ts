import { db, stopsTable, shopifyIntegrationsTable, shopifyImportLogsTable, customersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  created_at: string;
  note: string | null;
  total_weight: number;
  shipping_address: {
    first_name: string;
    last_name: string;
    address1: string;
    address2: string | null;
    city: string;
    province: string;
    zip: string;
    country: string;
    latitude: number | null;
    longitude: number | null;
    phone: string | null;
    name: string;
  } | null;
  line_items: Array<{
    title: string;
    quantity: number;
    grams: number;
  }>;
  fulfillment_status: string | null;
}

interface ShopifyOrdersResponse {
  orders: ShopifyOrder[];
}

async function shopifyFetch<T>(shopDomain: string, accessToken: string, path: string, options?: RequestInit): Promise<T> {
  const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const url = `https://${cleanDomain}/admin/api/2024-01${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchUnfulfilledOrders(shopDomain: string, accessToken: string): Promise<ShopifyOrder[]> {
  const data = await shopifyFetch<ShopifyOrdersResponse>(
    shopDomain,
    accessToken,
    "/orders.json?status=open&fulfillment_status=unfulfilled&limit=50"
  );
  return data.orders;
}

export async function verifyShopifyConnection(shopDomain: string, accessToken: string): Promise<{ shopName: string }> {
  const data = await shopifyFetch<{ shop: { name: string } }>(
    shopDomain,
    accessToken,
    "/shop.json"
  );
  return { shopName: data.shop.name };
}

const STOCKHOLM_COORDS = { lat: 59.3293, lng: 18.0686 };

function geocodeAddress(address: ShopifyOrder["shipping_address"]): { lat: number; lng: number } {
  if (address?.latitude && address?.longitude) {
    return { lat: address.latitude, lng: address.longitude };
  }
  const lat = STOCKHOLM_COORDS.lat + (Math.random() - 0.5) * 0.1;
  const lng = STOCKHOLM_COORDS.lng + (Math.random() - 0.5) * 0.2;
  return { lat, lng };
}

function formatAddress(addr: ShopifyOrder["shipping_address"]): string {
  if (!addr) return "Unknown address";
  const parts = [addr.address1, addr.address2, addr.zip, addr.city, addr.country].filter(Boolean);
  return parts.join(", ");
}

export async function importShopifyOrders(organizationId: string): Promise<{
  ordersFound: number;
  ordersImported: number;
  ordersSkipped: number;
  errors: string[];
}> {
  const [integration] = await db
    .select()
    .from(shopifyIntegrationsTable)
    .where(
      and(
        eq(shopifyIntegrationsTable.organizationId, organizationId),
        eq(shopifyIntegrationsTable.isActive, true)
      )
    );

  if (!integration) {
    throw new Error("No active Shopify integration found for this organization");
  }

  const orders = await fetchUnfulfilledOrders(integration.shopDomain, integration.accessToken);
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;

  for (const order of orders) {
    try {
      const existing = await db
        .select({ id: stopsTable.id })
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.organizationId, organizationId),
            eq(stopsTable.shopifyOrderId, String(order.id))
          )
        );

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      if (!order.shipping_address) {
        errors.push(`Order ${order.name}: No shipping address`);
        skipped++;
        continue;
      }

      const coords = geocodeAddress(order.shipping_address);
      const address = formatAddress(order.shipping_address);
      const contactName = order.shipping_address.name || `${order.shipping_address.first_name} ${order.shipping_address.last_name}`;
      const totalWeightKg = order.total_weight ? order.total_weight / 1000 : null;
      const trackingCode = `SH-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

      let customerId: string | undefined;
      if (order.email) {
        const [existingCustomer] = await db
          .select()
          .from(customersTable)
          .where(
            and(
              eq(customersTable.organizationId, organizationId),
              eq(customersTable.email, order.email)
            )
          );

        if (existingCustomer) {
          customerId = existingCustomer.id;
        } else {
          const [newCustomer] = await db
            .insert(customersTable)
            .values({
              organizationId,
              name: contactName,
              email: order.email,
              phone: order.shipping_address.phone ?? undefined,
              address,
            })
            .returning();
          customerId = newCustomer.id;
        }
      }

      const itemsSummary = order.line_items.map(li => `${li.quantity}x ${li.title}`).join(", ");

      await db.insert(stopsTable).values({
        organizationId,
        address,
        latitude: coords.lat,
        longitude: coords.lng,
        weightKg: totalWeightKg,
        contactName,
        contactEmail: order.email || undefined,
        notes: `Shopify ${order.name}: ${itemsSummary}`,
        trackingCode,
        shopifyOrderId: String(order.id),
        shopifyOrderName: order.name,
        customerId,
        status: "pending",
        serviceDurationMin: 10,
      });

      imported++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Order ${order.name}: ${msg}`);
    }
  }

  await db.update(shopifyIntegrationsTable).set({
    lastSyncAt: new Date(),
    totalOrdersImported: integration.totalOrdersImported + imported,
    updatedAt: new Date(),
  }).where(eq(shopifyIntegrationsTable.id, integration.id));

  await db.insert(shopifyImportLogsTable).values({
    organizationId,
    ordersFound: orders.length,
    ordersImported: imported,
    ordersSkipped: skipped,
    errors: errors.length > 0 ? JSON.stringify(errors) : null,
  });

  return {
    ordersFound: orders.length,
    ordersImported: imported,
    ordersSkipped: skipped,
    errors,
  };
}

export async function createShopifyFulfillment(
  shopDomain: string,
  accessToken: string,
  orderId: string,
  trackingCode: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await shopifyFetch(
      shopDomain,
      accessToken,
      `/orders/${orderId}/fulfillments.json`,
      {
        method: "POST",
        body: JSON.stringify({
          fulfillment: {
            tracking_number: trackingCode,
            notify_customer: true,
          },
        }),
      }
    );
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to create Shopify fulfillment for order ${orderId}: ${msg}`);
    return { success: false, error: msg };
  }
}
