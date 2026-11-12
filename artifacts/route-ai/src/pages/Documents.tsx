import { useRef, useState } from "react";
import { downloadPrivateFile } from "@/lib/private-download";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/ui/LoadingState";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FileText, FileImage, Upload, Trash2, Download, File } from "lucide-react";
import { localizeError } from "@/lib/localize-error";

const API_BASE = import.meta.env.VITE_API_URL || "";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
];

type DocumentRecord = {
  id: string;
  name: string;
  fileUrl: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getFileIcon(contentType: string) {
  if (contentType === "application/pdf")
    return <FileText className="h-5 w-5 text-red-400 flex-shrink-0" />;
  if (contentType.startsWith("image/"))
    return <FileImage className="h-5 w-5 text-blue-400 flex-shrink-0" />;
  return <File className="h-5 w-5 text-muted-foreground flex-shrink-0" />;
}

/** Convert a stored fileUrl (/objects/uploads/uuid) to a download API path */
function toDownloadPath(fileUrl: string): string {
  // fileUrl is like /objects/uploads/<uuid>
  // Download route is /api/storage/objects/<wildcardPath>
  // The wildcard picks up everything after /objects/ from the actual object path
  const prefix = "/objects";
  const wildcard = fileUrl.startsWith(prefix) ? fileUrl.slice(prefix.length) : fileUrl;
  return `${API_BASE}/api/storage/objects${wildcard}`;
}

export default function Documents() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRecord | null>(null);

  const { data, isLoading, error } = useQuery<{ documents: DocumentRecord[] }>({
    queryKey: ["/api/documents", organizationId],
    queryFn: () =>
      fetch(`${API_BASE}/api/documents`).then((r) => {
        if (!r.ok) {
          const error = new Error("Failed to load documents");
          Object.assign(error, { status: r.status });
          throw error;
        }
        return r.json();
    }),
    enabled: !!organizationId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`${API_BASE}/api/documents/${id}`, { method: "DELETE" }).then((r) => {
        if (!r.ok && r.status !== 204) {
          const error = new Error("Delete failed");
          Object.assign(error, { status: r.status });
          throw error;
        }
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents", organizationId] });
      toast({ title: t("documents.deleteSuccess") });
      setDeleteTarget(null);
    },
    onError: (error) => {
      toast({ title: t("common.error"), description: localizeError(error, t, { fallbackKey: "documents.uploadError" }), variant: "destructive" });
      setDeleteTarget(null);
    },
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so same file can be re-selected

    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: t("documents.errorMaxSize"), variant: "destructive" });
      return;
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: t("documents.errorType"), variant: "destructive" });
      return;
    }

    setIsUploading(true);
    try {
      // Step 1: request a server-issued presigned upload URL bound to this user + org
      const intentRes = await fetch(`${API_BASE}/api/documents/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!intentRes.ok) {
        const err = await intentRes.json().catch(() => ({}));
        const error = new Error((err as { error?: string }).error ?? "Failed to get upload URL");
        Object.assign(error, { status: intentRes.status, data: err });
        throw error;
      }
      const { uploadURL, intentId } = await intentRes.json() as { uploadURL: string; intentId: string };

      // Step 2: upload directly to object storage via the presigned URL
      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
       if (!uploadRes.ok) {
         const error = new Error("Object storage upload failed");
         Object.assign(error, { status: uploadRes.status });
         throw error;
       }

      // Step 3: register the document — server validates the intent and sets ACL
      const createRes = await fetch(`${API_BASE}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentId, name: file.name }),
      });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        const error = new Error((err as { error?: string }).error ?? "Failed to save document");
        Object.assign(error, { status: createRes.status, data: err });
        throw error;
      }

      queryClient.invalidateQueries({ queryKey: ["/api/documents", organizationId] });
      toast({ title: t("documents.uploadSuccess") });
    } catch (err) {
      console.error("Upload error:", err);
      toast({
        title: t("documents.uploadError"),
        description: localizeError(err, t, { fallbackKey: "documents.uploadError" }),
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  }

  const documents = data?.documents ?? [];

  return (
    <AppLayout>
      <div className="p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("documents.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">{t("documents.subtitle")}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="gap-2"
            >
              <Upload className="h-4 w-4" />
              {isUploading ? t("documents.uploading") : t("documents.upload")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("documents.allowedTypes")}</p>
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_TYPES.join(",")}
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Content */}
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} />
        ) : documents.length === 0 ? (
          <div className="bg-card rounded-xl border border-border p-12 flex flex-col items-center justify-center text-center">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium text-foreground">{t("documents.emptyTitle")}</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">{t("documents.emptyBody")}</p>
            <Button
              variant="outline"
              className="mt-6 gap-2"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              <Upload className="h-4 w-4" />
              {t("documents.upload")}
            </Button>
          </div>
        ) : (
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <DualHorizontalScroll label={t("common.horizontalScroll")}>
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[44px]" />
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("documents.name")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">{t("documents.size")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">{t("documents.date")}</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {documents.map((doc) => (
                  <tr key={doc.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">{getFileIcon(doc.contentType)}</td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-foreground truncate max-w-xs block">{doc.name}</span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                      {formatBytes(doc.sizeBytes)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell whitespace-nowrap">
                      {formatDate(doc.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <a href={toDownloadPath(doc.fileUrl)} download={doc.name} onClick={event => {
                          event.preventDefault();
                          void downloadPrivateFile(toDownloadPath(doc.fileUrl), doc.name).catch(error => window.alert(error.message));
                        }}>
                          <Button variant="ghost" size="icon" title={t("documents.download")}>
                            <Download className="h-4 w-4" />
                          </Button>
                        </a>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("documents.delete")}
                          onClick={() => setDeleteTarget(doc)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </DualHorizontalScroll>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("documents.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("documents.deleteConfirm")}
              {deleteTarget && (
                <span className="block mt-1 font-medium text-foreground">{deleteTarget.name}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {t("documents.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
