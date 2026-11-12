export interface ReportCategory { id: string; label: string; active: boolean }
export interface CategoryCachePorts {
  organizationId(): string;
  fetch(): Promise<{ categories: ReportCategory[] }>;
  read(key: string, maxAge: number): Promise<ReportCategory[] | null>;
  write(key: string, value: ReportCategory[]): Promise<unknown>;
}
export async function loadScopedCategories(online: boolean, ports: CategoryCachePorts): Promise<ReportCategory[]> {
  let organizationId: string;
  try { organizationId = ports.organizationId(); } catch { return []; }
  const sameAccount = () => {
    try { return ports.organizationId() === organizationId; } catch { return false; }
  };
  const key = `report_categories_${organizationId}`;
  if (online) {
    try {
      const document = await ports.fetch();
      if (!sameAccount()) return [];
      await ports.write(key, document.categories);
      return sameAccount() ? document.categories.filter(category => category.active) : [];
    } catch { /* Offline cache is bounded and scoped to the original organization. */ }
  }
  const cached = await ports.read(key, 7 * 24 * 60 * 60 * 1000).catch(() => null);
  return sameAccount() ? (cached ?? []).filter(category => category.active) : [];
}
