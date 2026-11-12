import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { PlanningInputs } from "@workspace/api-client-react";

export function ResourceSelectionMode({ inputs, onChange }: {
  inputs: PlanningInputs;
  onChange: (patch: Partial<PlanningInputs>) => void;
}) {
  const id = useId();
  const { t } = useTranslation();
  return <div className="mt-2 space-y-1">
    <label htmlFor={id} className="text-sm font-medium">{t("import.vehicleSelectionSemantics")}</label>
    <select id={id} className="block w-full rounded-md border bg-background px-3 py-2 text-sm"
      value={inputs.vehicleSelectionMode}
      onChange={event => onChange({ vehicleSelectionMode: event.target.value as PlanningInputs["vehicleSelectionMode"] })}>
      <option value="use_all_selected_pairs">{t("import.useAllSelectedPairs")}</option>
      <option value="minimize_vehicles">{t("import.allowUnusedResources")}</option>
    </select>
    {inputs.objective === "minimize_vehicles" && inputs.vehicleSelectionMode === "use_all_selected_pairs" &&
      <p role="status" className="text-xs text-muted-foreground">{t("import.allResourcesDespiteFleetGoal")}</p>}
  </div>;
}
