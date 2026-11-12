import type { ReactNode } from "react";

interface MapDriverSelectionProps {
  routes: { id: string; name: string }[];
  selected: ReadonlySet<string>;
  onSelect: (routeId: string, additive: boolean) => void;
  onClear?: () => void;
  actions?: ReactNode;
}

/** Keep the modifiers from the map click, including when choosing by keyboard. */
export function MapRouteChoices({ routes, selected, additive, onSelect, onClose }: {
  routes: { id: string; name: string; color: string }[];
  selected: ReadonlySet<string>;
  additive: boolean;
  onSelect: (routeId: string, additive: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div role="group" aria-label="Välj rutt vid kartklick" data-testid="map-route-choices"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}>
      <p className="font-semibold">Flera rutter här – välj chaufför</p>
      <p className="text-xs text-muted-foreground">
        {additive ? "Lägg till eller ta bort en chaufför." : "Välj en chaufför. Shift/Ctrl/Meta lägger till eller tar bort."}
      </p>
      <div className="max-h-48 overflow-y-auto">
        {routes.map((route, index) => (
          <button type="button" key={route.id} autoFocus={index === 0}
            data-testid={`map-route-choice-${route.id}`} aria-pressed={selected.has(route.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            onClick={(event) => onSelect(route.id, additive || event.shiftKey || event.ctrlKey || event.metaKey)}>
            <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: route.color }} />
            <span className="break-words">{route.name}</span>
            {selected.has(route.id) && <span className="text-xs">Markerad</span>}
          </button>
        ))}
      </div>
      <button type="button" onClick={onClose} className="mt-2 rounded px-2 py-2 hover:bg-muted">Avbryt</button>
    </div>
  );
}

/** Native controls provide the keyboard equivalent of route-line selection. */
export function MapDriverSelection({ routes, selected, onSelect, onClear, actions }: MapDriverSelectionProps) {
  return (
    <details className="absolute right-3 top-3 z-[1000] max-h-[calc(100%-1.5rem)] overflow-y-auto max-w-[min(18rem,70%)] rounded-md border border-border bg-card/95 text-xs shadow-sm">
      <summary className="h-7 cursor-pointer rounded px-2 py-0 text-[11px] font-semibold leading-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:leading-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        Välj chaufförer ({selected.size})
      </summary>
      <p className="max-w-60 px-2 py-2 text-muted-foreground">
        Klicka en rutt för enkelval. Shift/Ctrl/Meta-klick lägger till eller tar bort. Kryssrutorna kan styras med Tab och mellanslag.
      </p>
      <div className="max-h-48 overflow-y-auto">
        {routes.map((route) => (
          <label key={route.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 hover:bg-muted">
            <input type="checkbox" data-testid={`map-driver-select-${route.id}`}
              checked={selected.has(route.id)} onChange={() => onSelect(route.id, true)}
              className="accent-primary" />
            <span className="break-words">{route.name}</span>
          </label>
        ))}
      </div>
      {onClear && (
        <button type="button" data-testid="map-clear-drivers" disabled={selected.size === 0}
          className="mt-2 rounded px-2 py-2 font-semibold hover:bg-muted disabled:opacity-50"
          onClick={onClear}>Avmarkera chaufförer</button>
      )}
      {actions}
    </details>
  );
}
