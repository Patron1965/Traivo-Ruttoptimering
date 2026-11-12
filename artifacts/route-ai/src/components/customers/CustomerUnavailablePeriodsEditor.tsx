import type {
  UseFieldArrayAppend,
  UseFieldArrayRemove,
  UseFormRegister,
} from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomerFormInput } from "./CustomerForm";

export type CustomerUnavailablePeriodFormValue = {
  weekday: number;
  start: string;
  end: string;
};

export type CustomerUnavailablePeriodField = CustomerUnavailablePeriodFormValue & {
  id: string;
};

export type CustomerUnavailablePeriodErrors = Array<{
  weekday?: { message?: string };
  start?: { message?: string };
  end?: { message?: string };
} | undefined>;

interface CustomerUnavailablePeriodsEditorProps {
  fields: CustomerUnavailablePeriodField[];
  register: UseFormRegister<CustomerFormInput>;
  append: UseFieldArrayAppend<CustomerFormInput, "unavailablePeriods">;
  remove: UseFieldArrayRemove;
  errors?: CustomerUnavailablePeriodErrors;
}

const weekdays = [
  ["1", "Måndag"],
  ["2", "Tisdag"],
  ["3", "Onsdag"],
  ["4", "Torsdag"],
  ["5", "Fredag"],
  ["6", "Lördag"],
  ["7", "Söndag"],
] as const;

export function CustomerUnavailablePeriodsEditor({
  fields,
  register,
  append,
  remove,
  errors,
}: CustomerUnavailablePeriodsEditorProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        <p>
          {t(
            "customers.unavailablePeriodsDescription",
            "Varje period återkommer varje vecka. Hela servicetiden måste ligga utanför spärren, annars kan besöket inte planeras.",
          )}
        </p>
        <p className="mt-1">
          {t(
            "customers.unavailablePeriodsOvernight",
            "Varje spärr måste börja och sluta under samma veckodag. Spärrar över midnatt stöds inte ännu.",
          )}
        </p>
      </div>

      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("customers.noUnavailablePeriods", "Inga återkommande spärrar tillagda.")}
        </p>
      ) : (
        <div className="space-y-3">
          {fields.map((field, index) => {
            const rowErrors = errors?.[index];
            const weekdayName = `unavailablePeriods.${index}.weekday` as const;
            const startName = `unavailablePeriods.${index}.start` as const;
            const endName = `unavailablePeriods.${index}.end` as const;
            return (
              <div key={field.id} className="rounded-md border bg-muted/20 p-3">
                <div className="grid gap-3 sm:grid-cols-[1.2fr_1fr_1fr_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label htmlFor={`unavailable-weekday-${field.id}`}>
                      {t("customers.unavailableWeekday", "Veckodag")}
                    </Label>
                    <select
                      id={`unavailable-weekday-${field.id}`}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      {...register(weekdayName, { valueAsNumber: true })}
                    >
                      {weekdays.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    {rowErrors?.weekday?.message && (
                      <p className="text-xs text-destructive">{rowErrors.weekday.message}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`unavailable-start-${field.id}`}>
                      {t("customers.unavailableStart", "Från")}
                    </Label>
                    <Input
                      id={`unavailable-start-${field.id}`}
                      type="time"
                      step={60}
                      {...register(startName)}
                    />
                    {rowErrors?.start?.message && (
                      <p className="text-xs text-destructive">{rowErrors.start.message}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`unavailable-end-${field.id}`}>
                      {t("customers.unavailableEnd", "Till")}
                    </Label>
                    <Input
                      id={`unavailable-end-${field.id}`}
                      type="time"
                      step={60}
                      {...register(endName)}
                    />
                    {rowErrors?.end?.message && (
                      <p className="text-xs text-destructive">{rowErrors.end.message}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => remove(index)}
                    aria-label={t("customers.removeUnavailablePeriod", "Ta bort spärr")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ weekday: 1, start: "09:00", end: "10:00" })}
      >
        <Plus className="mr-1.5 h-4 w-4" />
        {t("customers.addUnavailablePeriod", "Lägg till spärr")}
      </Button>
    </div>
  );
}