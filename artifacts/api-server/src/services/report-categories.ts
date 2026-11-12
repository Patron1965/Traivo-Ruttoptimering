import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";

export const ReportCategoriesInput = z.object({
  revision: z.number().int().min(0),
  categories: z.array(z.object({
    id: z.guid(),
    label: z.string().trim().min(1).max(80),
    active: z.boolean(),
  }).strict()).max(60),
}).strict().superRefine(({ categories }, ctx) => {
  const ids = new Set<string>(), labels = new Set<string>();
  for (const category of categories) {
    const label = category.label.toLocaleLowerCase("sv-SE");
    if (ids.has(category.id) || (category.active && labels.has(label))) {
      ctx.addIssue({ code: "custom", message: "Kategorier måste ha unika id och aktiva namn." });
    }
    ids.add(category.id);
    if (category.active) labels.add(label);
  }
});

export async function updateReportCategories(organizationId: string, input: unknown) {
  const parsed = ReportCategoriesInput.parse(input);
  return db.transaction(async tx => {
    const [org] = await tx.select({ config: organizationsTable.reportCategories })
      .from(organizationsTable).where(eq(organizationsTable.id, organizationId)).for("update");
    if (!org) throw Object.assign(new Error("Företaget finns inte."), { statusCode: 404 });
    if (org.config.revision !== parsed.revision) {
      throw Object.assign(new Error("Kategorierna har ändrats. Läs in dem igen innan du sparar."), { statusCode: 409 });
    }
    const ids = new Set(parsed.categories.map(category => category.id));
    if (org.config.categories.some(category => !ids.has(category.id))) {
      throw Object.assign(new Error("Inaktivera kategorin i stället för att ta bort den."), { statusCode: 400 });
    }
    const config = { revision: parsed.revision + 1, categories: parsed.categories };
    await tx.update(organizationsTable).set({ reportCategories: config }).where(eq(organizationsTable.id, organizationId));
    return config;
  });
}
