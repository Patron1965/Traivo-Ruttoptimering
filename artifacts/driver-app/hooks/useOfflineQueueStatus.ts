import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import {
  getOfflineQueueItems,
  reclaimLegacyQueueItem,
  scanLegacyOfflineQueues,
  markLegacyQuarantineItem,
  getConflictArchive,
  type OfflineQueueItem,
} from "@/lib/offline-queue";
import {
  safeLegacyRecoveryMetadata,
  type LegacyQuarantineItem,
} from "@/lib/offline-quarantine";
import { localizeError } from "@/lib/error-localizer";
import { useT } from "@/lib/i18n";

export function useOfflineQueueStatus(allowLegacyReclaim = true) {
  const { lang, t } = useT();
  const [items, setItems] = useState<OfflineQueueItem[]>([]);
  const [legacyItems, setLegacyItems] = useState<LegacyQuarantineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const nextLegacy = await scanLegacyOfflineQueues();
        if (mounted) {
          setLegacyItems(nextLegacy);
          setLegacyError(null);
        }
      } catch (legacyError) {
        if (mounted) setLegacyError(localizeError(legacyError, lang, { fallback: t("errors.generic") }));
      }
      getOfflineQueueItems().then((next) => {
        if (mounted) {
          setItems(next);
          setError(null);
          setLoaded(true);
        }
      }).catch((nextError) => {
        if (mounted) {
          setError(localizeError(nextError, lang, { fallback: t("errors.generic") }));
          setLoaded(true);
        }
      });
      getConflictArchive().then(next => { if (mounted) setArchivedCount(next.length); })
        .catch(err => { if (mounted) setError(localizeError(err, lang)); });
    };
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [lang, t]);

  const reclaimLegacyItem = async (quarantineId: string) => {
    if (!allowLegacyReclaim) {
      throw new Error("OFFLINE_QUEUE_ERROR");
    }
    const item = legacyItems.find((candidate) => candidate.quarantineId === quarantineId);
    if (!item?.stopId) throw new Error("OFFLINE_QUEUE_ERROR");
    try {
      const authorizedStop = await api.getStop(item.stopId);
      if (authorizedStop.id !== item.stopId) throw new Error("OFFLINE_QUEUE_ERROR");
      await reclaimLegacyQueueItem(quarantineId);
      setLegacyItems(await scanLegacyOfflineQueues());
    } catch (reclaimError) {
      if (reclaimError instanceof ApiError && (reclaimError.status === 403 || reclaimError.status === 404)) {
        await markLegacyQuarantineItem(
          quarantineId,
          "denied",
          "FORBIDDEN",
        );
        setLegacyItems(await scanLegacyOfflineQueues());
      }
      throw reclaimError;
    }
  };

  return {
    loaded,
    archivedCount,
    items,
    error: error ?? legacyError,
    legacyItems,
    legacyPendingCount: legacyItems.filter((item) => item.state === "unresolved").length,
    reclaimLegacyItem,
    safeLegacyRecoveryMetadata: legacyItems.map(safeLegacyRecoveryMetadata),
    pending: items.filter((item) => !item.syncStatus || item.syncStatus === "pending" || item.syncStatus === "failed" || item.syncStatus === "syncing"),
    conflicts: items.filter((item) => item.syncStatus === "conflict"),
    synced: items.filter((item) => item.syncStatus === "synced"),
  };
}