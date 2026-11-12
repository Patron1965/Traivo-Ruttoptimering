import { useState, useEffect, useRef } from "react";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { useTranslation } from "react-i18next";
import { useBranding, useSaveBranding, useResetBranding, useUploadLogo, useExtractBranding, useImportLogo, type Brand } from "@/hooks/use-branding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, Trash2, Globe, RefreshCcw, Palette, Image as ImageIcon, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { computeThemeVariables } from "@/lib/theme-utils";
import { localizeError } from "@/lib/localize-error";

const DEFAULT_BRAND: Brand = {
  displayName: null,
  websiteUrl: null,
  primaryColor: null,
  accentColor: null,
  backgroundColor: null,
  logoUrl: null,
  logoDarkUrl: null,
};

// Contrast checker
function getContrastRatio(hex1: string, hex2: string) {
  const getLuminance = (hex: string) => {
    const rgb = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!rgb) return 0;
    const a = [parseInt(rgb[1], 16), parseInt(rgb[2], 16), parseInt(rgb[3], 16)].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  };
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function BrandingSettings() {
  const { t } = useTranslation();
  const { data: currentBrand, isLoading } = useBranding();
  const saveMutation = useSaveBranding();
  const resetMutation = useResetBranding();
  const uploadMutation = useUploadLogo();
  const extractMutation = useExtractBranding();
  const importMutation = useImportLogo();
  const { toast } = useToast();

  const [draft, setDraft] = useState<Brand>(DEFAULT_BRAND);
  const [extractUrl, setExtractUrl] = useState("");
  const [extractResult, setExtractResult] = useState<any>(null);
  const [previewMode, setPreviewMode] = useState<"light" | "dark">("light");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const darkFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (currentBrand) {
      setDraft(currentBrand);
      setExtractUrl(currentBrand.websiteUrl || "");
    }
  }, [currentBrand]);

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="animate-spin h-8 w-8 text-primary" /></div>;
  }

  const handleSave = () => {
    saveMutation.mutate(draft, {
      onSuccess: () => {
        toast({ title: "Sparat", description: "Kundanpassning har sparats." });
      },
      onError: (error) => {
        toast({ title: "Fel", description: localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
      }
    });
  };

  const handleReset = () => {
    if (confirm("Är du säker på att du vill återställa till Traivos standardutseende?")) {
      resetMutation.mutate(undefined, {
        onSuccess: (defaultBrand) => {
          setDraft(defaultBrand);
          toast({ title: "Återställt", description: "Standardutseendet är återställt." });
        },
        onError: (err: any) => {
          toast({ title: "Fel", description: localizeError(err, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
        }
      });
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, isDark: boolean) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "För stor fil", description: "Logotypen måste vara mindre än 2 MB.", variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target?.result as string;
      // Extract data part
      const data = base64.split(",")[1];
      try {
        const res = await uploadMutation.mutateAsync({ data, contentType: file.type });
        if (isDark) {
          setDraft(prev => ({ ...prev, logoDarkUrl: res.logoUrl }));
        } else {
          setDraft(prev => ({ ...prev, logoUrl: res.logoUrl }));
        }
        toast({ title: "Uppladdad", description: "Logotypen har laddats upp till utkastet." });
      } catch (err: any) {
        toast({ title: "Fel", description: localizeError(err, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleExtract = async () => {
    if (!extractUrl) return;
    try {
      const res = await extractMutation.mutateAsync(extractUrl);
      setExtractResult(res);
      toast({ title: "Extrahering klar", description: "Granska förslagen nedan." });
    } catch (err: any) {
      toast({ title: "Fel", description: localizeError(err, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
    }
  };

  const handleImportLogo = async (url: string) => {
    try {
      const res = await importMutation.mutateAsync(url);
      setDraft(prev => ({ ...prev, logoUrl: res.logoUrl, websiteUrl: extractUrl }));
      toast({ title: "Importerad", description: "Logotypen har lagts till i utkastet." });
    } catch (err: any) {
      toast({ title: "Fel", description: localizeError(err, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
    }
  };

  const contrastWarning = draft.primaryColor 
    ? getContrastRatio(draft.primaryColor, previewMode === "dark" ? "#1e293b" : "#ffffff") < 3 
    : false;

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(currentBrand || DEFAULT_BRAND);

  const previewVars = computeThemeVariables(draft, previewMode);
  const previewStyle = Object.fromEntries(
    Object.entries(previewVars).map(([k, v]) => [k, v])
  ) as Record<string, string> & React.CSSProperties;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Kundanpassning</h1>
        <p className="text-muted-foreground mt-1">Anpassa logotyp, färger och hemsida. Gäller för inloggade vyer och spårningssidan.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Manuella inställningar */}
        <div className="space-y-6">
          <div className="bg-card rounded-xl border border-border p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Palette className="h-5 w-5 text-primary" />
              Designinställningar
            </h2>
            
            <div className="space-y-2">
              <Label>Visningsnamn (Valfritt)</Label>
              <Input 
                value={draft.displayName || ""} 
                onChange={e => setDraft(prev => ({ ...prev, displayName: e.target.value || null }))}
                placeholder="Ex. Företaget AB"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Huvudfärg</Label>
                <div className="flex gap-2">
                  <Input 
                    type="color" 
                    value={draft.primaryColor || "#3b82f6"} 
                    onChange={e => setDraft(prev => ({ ...prev, primaryColor: e.target.value }))}
                    className="w-10 p-1 h-10 shrink-0"
                  />
                  <Input 
                    type="text" 
                    value={draft.primaryColor || ""} 
                    onChange={e => setDraft(prev => ({ ...prev, primaryColor: e.target.value || null }))}
                    placeholder="#3b82f6"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Accentfärg</Label>
                <div className="flex gap-2">
                  <Input 
                    type="color" 
                    value={draft.accentColor || "#10b981"} 
                    onChange={e => setDraft(prev => ({ ...prev, accentColor: e.target.value }))}
                    className="w-10 p-1 h-10 shrink-0"
                  />
                  <Input 
                    type="text" 
                    value={draft.accentColor || ""} 
                    onChange={e => setDraft(prev => ({ ...prev, accentColor: e.target.value || null }))}
                    placeholder="#10b981"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Bakgrund</Label>
                <div className="flex gap-2">
                  <Input 
                    type="color" 
                    value={draft.backgroundColor || "#ffffff"} 
                    onChange={e => setDraft(prev => ({ ...prev, backgroundColor: e.target.value }))}
                    className="w-10 p-1 h-10 shrink-0"
                  />
                  <Input 
                    type="text" 
                    value={draft.backgroundColor || ""} 
                    onChange={e => setDraft(prev => ({ ...prev, backgroundColor: e.target.value || null }))}
                    placeholder="#ffffff"
                  />
                </div>
              </div>
            </div>

            {contrastWarning && (
              <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Kontrastvarning</AlertTitle>
                <AlertDescription>
                  Huvudfärgen har låg kontrast mot {previewMode === "dark" ? "mörk" : "ljus"} bakgrund. 
                  Detta kan göra text svårläst.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-4 pt-2">
              <Label>Logotyper</Label>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Standard (Ljus bakgrund)</Label>
                  <div className="flex items-center gap-2">
                    {draft.logoUrl ? (
                      <div className="relative group rounded border p-2 bg-white w-full flex justify-center items-center h-20">
                        <WorkspaceImage src={draft.logoUrl} alt="Logo" className="max-h-full max-w-full object-contain" />
                        <button onClick={() => setDraft(prev => ({ ...prev, logoUrl: null }))} className="absolute inset-0 bg-black/50 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded">
                          <Trash2 className="h-5 w-5" />
                        </button>
                      </div>
                    ) : (
                      <Button variant="outline" className="w-full h-20 border-dashed" onClick={() => fileInputRef.current?.click()}>
                        <Upload className="h-4 w-4 mr-2" />
                        Ladda upp
                      </Button>
                    )}
                    <input type="file" ref={fileInputRef} className="hidden" accept="image/png, image/jpeg, image/svg+xml, image/webp" onChange={e => handleFileChange(e, false)} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Mörkt läge (Valfritt)</Label>
                  <div className="flex items-center gap-2">
                    {draft.logoDarkUrl ? (
                      <div className="relative group rounded border p-2 bg-slate-900 w-full flex justify-center items-center h-20">
                        <WorkspaceImage src={draft.logoDarkUrl} alt="Logo Dark" className="max-h-full max-w-full object-contain" />
                        <button onClick={() => setDraft(prev => ({ ...prev, logoDarkUrl: null }))} className="absolute inset-0 bg-black/50 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded">
                          <Trash2 className="h-5 w-5" />
                        </button>
                      </div>
                    ) : (
                      <Button variant="outline" className="w-full h-20 border-dashed" onClick={() => darkFileInputRef.current?.click()}>
                        <Upload className="h-4 w-4 mr-2" />
                        Ladda upp
                      </Button>
                    )}
                    <input type="file" ref={darkFileInputRef} className="hidden" accept="image/png, image/jpeg, image/svg+xml, image/webp" onChange={e => handleFileChange(e, true)} />
                  </div>
                </div>
              </div>
            </div>
            
            <div className="space-y-2 pt-2">
              <Label>Hemsida</Label>
              <Input 
                type="url"
                value={draft.websiteUrl || ""} 
                onChange={e => setDraft(prev => ({ ...prev, websiteUrl: e.target.value || null }))}
                placeholder="https://example.com"
              />
            </div>
          </div>
          
          <div className="bg-card rounded-xl border border-border p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              Hämta från hemsida
            </h2>
            <p className="text-sm text-muted-foreground">
              Ange kundens hemsida för att automatiskt föreslå logotyp och färger. Inget sparas innan du godkänner.
            </p>
            <div className="flex gap-2">
              <Input 
                placeholder="https://example.com"
                value={extractUrl}
                onChange={e => setExtractUrl(e.target.value)}
              />
              <Button onClick={handleExtract} disabled={extractMutation.isPending || !extractUrl}>
                {extractMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Hämta"}
              </Button>
            </div>
            
            {extractResult && (
              <div className="mt-4 p-4 border rounded-lg bg-muted/30 space-y-4">
                {extractResult.warnings?.length > 0 && (
                  <div className="text-amber-500 text-xs space-y-1">
                    {extractResult.warnings.map((w: string, i: number) => <div key={i}>• {w}</div>)}
                  </div>
                )}
                
                {extractResult.colors?.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-xs">Föreslagna färger</Label>
                    <div className="flex flex-wrap gap-2">
                      {extractResult.colors.map((c: string) => (
                        <button
                          key={c}
                          onClick={() => setDraft(prev => ({ ...prev, primaryColor: c }))}
                          className="w-8 h-8 rounded-full shadow-sm border border-border hover:scale-110 transition-transform cursor-pointer"
                          style={{ backgroundColor: c }}
                          title={`Använd ${c} som huvudfärg`}
                        />
                      ))}
                    </div>
                  </div>
                )}
                
                {extractResult.logos?.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-xs">Föreslagna logotyper</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {extractResult.logos.map((l: any, i: number) => (
                        <div key={i} className="border bg-white rounded p-4 flex flex-col items-center gap-3">
                          <p className="text-xs text-muted-foreground truncate w-full text-center font-medium">{l.label || `Logotyp ${i + 1}`}</p>
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="w-full text-xs"
                            onClick={() => handleImportLogo(l.url)} 
                            disabled={importMutation.isPending}
                          >
                            Importera och använd
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Förhandsvisning */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Förhandsvisning</h2>
            <div className="flex items-center gap-2">
              <Label htmlFor="preview-mode" className="text-xs">{previewMode === "dark" ? "Mörkt" : "Ljust"}</Label>
              <Switch 
                id="preview-mode" 
                checked={previewMode === "dark"} 
                onCheckedChange={c => setPreviewMode(c ? "dark" : "light")} 
              />
            </div>
          </div>
          
          <div 
            className={`border rounded-xl overflow-hidden transition-colors ${previewMode === "dark" ? "dark bg-slate-950 text-slate-50 border-slate-800" : "bg-white text-slate-900 border-slate-200"}`}
            style={{ 
              ...previewStyle,
              backgroundColor: previewVars['--background'] ? `hsl(${previewVars['--background']})` : undefined
            }}
          >
            {/* Header Preview */}
            <div className={`h-14 border-b px-4 flex items-center justify-between ${previewMode === "dark" ? "bg-slate-900 border-slate-800" : "bg-slate-50 border-slate-200"}`}>
              <div className="flex items-center gap-3">
                {previewMode === "dark" && draft.logoDarkUrl ? (
                  <img src={draft.logoDarkUrl} alt="Logo" className="h-8 max-w-[120px] object-contain" />
                ) : draft.logoUrl ? (
                  <img src={draft.logoUrl} alt="Logo" className="h-8 max-w-[120px] object-contain" />
                ) : (
                  <div 
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-white" 
                    style={{ backgroundColor: previewVars['--primary'] ? `hsl(${previewVars['--primary']})` : "#3b82f6" }}
                  >
                    <ImageIcon className="h-4 w-4" />
                  </div>
                )}
                <span className="font-bold text-lg" style={{ color: previewVars['--primary'] ? `hsl(${previewVars['--primary']})` : undefined }}>
                  {draft.displayName || "Traivo Route"}
                </span>
              </div>
              <div className="flex gap-2">
                <div 
                  className={`h-8 w-8 rounded-full ${previewMode === "dark" ? "bg-slate-800" : "bg-slate-200"}`} 
                  style={{ backgroundColor: previewVars['--muted'] ? `hsl(${previewVars['--muted']})` : undefined }} 
                />
              </div>
            </div>

            {/* Content Preview */}
            <div className="p-6 space-y-6">
              <div 
                className={`p-4 rounded-lg border ${previewMode === "dark" ? "bg-slate-900 border-slate-800" : "bg-slate-50 border-slate-200"}`}
                style={{ 
                  backgroundColor: previewVars['--muted'] ? `hsl(${previewVars['--muted']})` : undefined,
                  borderColor: previewVars['--border'] ? `hsl(${previewVars['--border']})` : undefined 
                }}
              >
                <h3 className="font-semibold mb-2" style={{ color: previewVars['--foreground'] ? `hsl(${previewVars['--foreground']})` : undefined }}>Aktiv Rutt</h3>
                <div className="space-y-3">
                  <div className="h-2 w-full rounded-full overflow-hidden" style={{ backgroundColor: previewVars['--border'] ? `hsl(${previewVars['--border']})` : (previewMode === "dark" ? "#334155" : "#e2e8f0") }}>
                    <div className="h-full rounded-full" style={{ width: "45%", backgroundColor: previewVars['--primary'] ? `hsl(${previewVars['--primary']})` : "#3b82f6" }} />
                  </div>
                  <div className="flex justify-between text-xs" style={{ color: previewVars['--muted-foreground'] ? `hsl(${previewVars['--muted-foreground']})` : (previewMode === "dark" ? "#94a3b8" : "#64748b") }}>
                    <span>Avklarat: 45%</span>
                    <span>3 kvar</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <Button className="w-full border-0" style={{ 
                  backgroundColor: previewVars['--primary'] ? `hsl(${previewVars['--primary']})` : "#3b82f6", 
                  color: previewVars['--primary-foreground'] ? `hsl(${previewVars['--primary-foreground']})` : "white" 
                }}>
                  Huvudknapp
                </Button>
                <Button variant="outline" className="w-full" style={{ 
                  borderColor: previewVars['--accent'] ? `hsl(${previewVars['--accent']})` : "#10b981", 
                  color: previewVars['--accent'] ? `hsl(${previewVars['--accent']})` : "#10b981", 
                  backgroundColor: "transparent" 
                }}>
                  Sekundär
                </Button>
              </div>
              
              <div className="flex justify-center">
                {draft.websiteUrl && (
                  <a href={draft.websiteUrl} target="_blank" rel="noreferrer" className="text-sm hover:underline" style={{ color: previewVars['--primary'] ? `hsl(${previewVars['--primary']})` : "#3b82f6" }}>
                    Besök hemsidan →
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>

      <div className="flex justify-between pt-6 border-t">
        <Button variant="outline" className="text-destructive hover:bg-destructive/10" onClick={handleReset} disabled={resetMutation.isPending}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          Återställ standard
        </Button>
        <div className="flex gap-3">
          <Button variant="ghost" onClick={() => setDraft(currentBrand || DEFAULT_BRAND)} disabled={!hasChanges}>
            Avbryt
          </Button>
          <Button onClick={handleSave} disabled={saveMutation.isPending || !hasChanges}>
            {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Spara inställningar
          </Button>
        </div>
      </div>
    </div>
  );
}
