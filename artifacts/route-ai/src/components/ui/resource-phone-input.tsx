import { useState } from "react";
import { Input } from "@/components/ui/input";
import { PHONE_COUNTRIES, phoneCountry, formatResourcePhone, normalizeResourcePhone } from "@/lib/resource-phone";

export function ResourcePhoneInput({ value, onChange, onBlur, id, name, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  id: string;
  name: string;
  inputRef: (instance: HTMLInputElement | null) => void;
}) {
  const [country, setCountry] = useState(() => phoneCountry(value));
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex h-11 items-center rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      <select
        aria-label="Land för telefonnummer"
        className="h-full w-20 rounded-l-md bg-transparent px-2 text-base"
        value={country}
        onChange={(event) => {
          const next = event.target.value;
          const normalized = normalizeResourcePhone(value, country === "other" ? "" : country);
          const national = country === "other" ? "" : normalized.replace(new RegExp(`^\\+${country}`), "");
          setCountry(next);
          onChange(next === "other" ? normalized : national ? `+${next}${national}` : "");
        }}
      >
        {PHONE_COUNTRIES.map(({ code, label }) => <option key={code} value={code}>{label} (+{code})</option>)}
        <option value="other">Annat land</option>
      </select>
      <Input
        id={id}
        name={name}
        ref={inputRef}
        type="tel"
        pattern={country === "other" ? "(\\+|00)[0-9 ().-]+" : undefined}
        title={country === "other" ? "Ange numret med internationell landskod, till exempel +44." : undefined}
        autoComplete="tel"
        className="h-full min-w-0 border-0 bg-transparent text-base shadow-none focus-visible:ring-0"
        placeholder={country === "46" ? "+46 (701) 234-567" : country === "other" ? "+ landskod och nummer" : `+${country}`}
        value={editing ? value : formatResourcePhone(value, country === "other" ? "" : country)}
        onFocus={() => setEditing(true)}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          if (next.startsWith("+") || next.startsWith("00")) setCountry(phoneCountry(next));
        }}
        onBlur={() => {
          setEditing(false);
          onChange(normalizeResourcePhone(value, country === "other" ? "" : country));
          onBlur();
        }}
      />
    </div>
  );
}
