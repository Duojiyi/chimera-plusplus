import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { backupsApi } from "@/lib/api";
import {
  PartialBackupRestoreError,
  restoreDatabaseBackup,
} from "@/lib/api/config";
import { promptCodexImportReview } from "@/utils/codexImportReview";

export function useBackupManager() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data: backups = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["db-backups"],
    queryFn: () => backupsApi.listDbBackups(),
  });

  const createMutation = useMutation({
    mutationFn: () => backupsApi.createDbBackup(),
    onSuccess: () => refetch(),
  });

  const restoreMutation = useMutation({
    mutationFn: restoreDatabaseBackup,
    onSettled: async (_data, error) => {
      // Partial success still changed the DB. Refresh it, but keep mutateAsync
      // rejected so BackupListSection cannot display its full-success toast.
      if (!error || error instanceof PartialBackupRestoreError) {
        try {
          await queryClient.invalidateQueries();
          await refetch();
        } catch (refreshError) {
          // Never replace the partial-restore warning with a refresh failure.
          console.error(
            "Failed to refresh restored database queries",
            refreshError,
          );
        }
        await promptCodexImportReview(t);
      }
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({
      oldFilename,
      newName,
    }: {
      oldFilename: string;
      newName: string;
    }) => backupsApi.renameDbBackup(oldFilename, newName),
    onSuccess: () => refetch(),
  });

  const deleteMutation = useMutation({
    mutationFn: (filename: string) => backupsApi.deleteDbBackup(filename),
    onSuccess: () => refetch(),
  });

  return {
    backups,
    isLoading,
    create: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    restore: restoreMutation.mutateAsync,
    isRestoring: restoreMutation.isPending,
    rename: renameMutation.mutateAsync,
    isRenaming: renameMutation.isPending,
    remove: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
  };
}
