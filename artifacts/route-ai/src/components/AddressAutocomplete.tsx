import { Loader2, MapPin } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import {
  addressSuggestions,
  selectedAddressValue,
  type AddressSuggestion,
  type GeocodeResponse,
  type PersistedVerifiedAddress,
} from "@/lib/address-suggestions";

export function AddressAutocomplete(props: {
  value: string | null | undefined;
  onChange: (value: string) => void;
  onSuggestionSelect?: (suggestion: AddressSuggestion) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  persistedVerifiedAddress?: PersistedVerifiedAddress | null;
}) {
  const {
    value,
    onChange,
    onSuggestionSelect,
    onBlur,
    placeholder,
    className,
    persistedVerifiedAddress,
  } = props;
  const { t } = useTranslation();
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = value?.trim() ?? "";
  const persistedValue = persistedVerifiedAddress?.value.trim() ?? "";
  const isPersistedVerified = Boolean(persistedValue && query === persistedValue);
  const [selectionStatus, setSelectionStatus] = useState<"verified" | "approximate" | null>(
    isPersistedVerified ? "verified" : null,
  );
  const selectedValue = useRef(isPersistedVerified ? persistedValue : "");
  const previousPersistedValue = useRef(persistedValue);
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const listboxId = `address-autocomplete-options-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    if (isPersistedVerified) {
      selectedValue.current = persistedValue;
      setSelectionStatus("verified");
      previousPersistedValue.current = persistedValue;
      return;
    }
    const persistedValueChanged = previousPersistedValue.current !== persistedValue;
    if (
      selectedValue.current
      && (selectedValue.current !== query || (persistedValueChanged && selectedValue.current === query))
    ) {
      selectedValue.current = "";
      setSelectionStatus(null);
    }
    previousPersistedValue.current = persistedValue;
  }, [isPersistedVerified, persistedValue, query]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setLookupError(null);
    if (query.length < 3 || query === selectedValue.current) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      setIsLoading(false);
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    const isCurrentRequest = () => (
      !controller.signal.aborted && requestGeneration.current === generation
    );
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`/api/geocode?address=${encodeURIComponent(query)}&country=se`, {
          credentials: "include",
          signal: controller.signal,
        });
        const body = await response.json() as GeocodeResponse;
        if (!isCurrentRequest()) return;
        const next = addressSuggestions(response.ok, body, query);
        setLookupError(response.ok ? null : response.status === 404 || response.status === 400
          ? "drivers.addressNotVerified"
          : "drivers.addressLookupFailed");
        const unique = [...new Map(next.map((item) => [item.displayName, item])).values()].slice(0, 6);
        setSuggestions(unique);
        setActiveIndex(-1);
        setIsOpen(unique.length > 0);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          if (!isCurrentRequest()) return;
          setLookupError("drivers.addressLookupFailed");
          setSuggestions([]);
          setIsOpen(false);
        }
      } finally {
        if (isCurrentRequest()) setIsLoading(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (activeRequest.current === controller) activeRequest.current = null;
    };
  }, [query, lookupAttempt]);

  const selectSuggestion = (suggestion: AddressSuggestion) => {
    const nextValue = selectedAddressValue(suggestion);
    requestGeneration.current++;
    activeRequest.current?.abort();
    activeRequest.current = null;
    selectedValue.current = nextValue;
    setSelectionStatus(suggestion.verified ? "verified" : "approximate");
    // A candidate is useful input, but it is not a successful exact lookup.
    // Keep the actionable candidate warning rather than the generic 404 text.
    setLookupError(null);
    onChange(nextValue);
    onSuggestionSelect?.(suggestion);
    setSuggestions([]);
    setIsOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div className={cn("relative", className)}>
      <Input
        value={value ?? ""}
        onChange={(event) => {
          requestGeneration.current++;
          activeRequest.current?.abort();
          activeRequest.current = null;
          selectedValue.current = "";
          setSelectionStatus(null);
          setSuggestions([]);
          setIsOpen(false);
          onChange(event.target.value);
        }}
        onFocus={() => suggestions.length > 0 && setIsOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setIsOpen(false), 150);
          onBlur?.();
        }}
        onKeyDown={(event) => {
          if (!isOpen || suggestions.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, suggestions.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && activeIndex >= 0) {
            event.preventDefault();
            selectSuggestion(suggestions[activeIndex]);
          } else if (event.key === "Escape") {
            setIsOpen(false);
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      />
      {isLoading && (
        <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}
      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-[80] mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.id}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-start gap-2 rounded-sm px-3 py-2 text-left text-sm",
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
                !suggestion.verified && "border-l-2 border-amber-500/70 bg-amber-500/5",
              )}
              // Keep the input focused so a pointer selection wins over the
              // delayed blur close.  Unlike a disabled button, this also
              // allows approximate candidates to populate the field.
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSuggestion(suggestion)}
            >
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{suggestion.displayName}{!suggestion.verified && (
                <span className="block text-xs text-muted-foreground">{t("drivers.addressApproximate")}</span>
              )}</span>
            </button>
          ))}
        </div>
      )}
      <p className={cn(
        "mt-1 text-xs",
        lookupError || selectionStatus === "approximate" ? "text-destructive" : "text-muted-foreground",
      )} role={lookupError || selectionStatus ? "status" : undefined}>
        {t(
          lookupError
            ?? (selectionStatus === "approximate"
              ? "drivers.addressApproximate"
              : selectionStatus === "verified" ? "drivers.addressVerified" : "drivers.addressHelp"),
        )}
      </p>
      {selectionStatus === "approximate" && (
        <button
          type="button"
          disabled={isLoading}
          className="mt-1 text-xs font-medium text-primary underline disabled:opacity-50"
          onClick={() => {
            selectedValue.current = "";
            setLookupAttempt((attempt) => attempt + 1);
          }}
        >
          {t("drivers.addressRecheck")}
        </button>
      )}
    </div>
  );
}