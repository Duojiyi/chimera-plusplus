import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi, settingsApi } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type {
  ManagedAuthProvider,
  ManagedAuthStatus,
  ManagedAuthDeviceCodeResponse,
} from "@/lib/api";

type PollingState = "idle" | "polling" | "success" | "error";

export function useManagedAuth(
  authProvider: ManagedAuthProvider,
  githubDomain?: string,
) {
  const queryClient = useQueryClient();
  const queryKey = ["managed-auth-status", authProvider];

  const [pollingState, setPollingState] = useState<PollingState>("idle");
  const [deviceCode, setDeviceCode] =
    useState<ManagedAuthDeviceCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptGenRef = useRef(0);
  const mountedRef = useRef(true);

  const {
    data: authStatus,
    isLoading: isLoadingStatus,
    refetch: refetchStatus,
  } = useQuery<ManagedAuthStatus>({
    queryKey,
    queryFn: () => authApi.authGetStatus(authProvider),
    staleTime: 30000,
    // A rejected xAI refresh token is persisted as `requires_reauth` by the
    // proxy hot path. Periodically refresh local status so an already-open Auth
    // Center stops showing the account as logged in without requiring a reload.
    refetchInterval: authProvider === "xai_oauth" ? 15_000 : false,
  });

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptGenRef.current += 1;
      stopPolling();
    };
  }, [stopPolling]);

  const startLoginMutation = useMutation({
    mutationFn: async (attemptGen: number) => {
      const response = await authApi.authStartLogin(authProvider, githubDomain);
      return { response, attemptGen };
    },
    onSuccess: async ({ response, attemptGen }) => {
      if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
        return;
      }
      setDeviceCode(response);
      setPollingState("polling");
      setError(null);

      try {
        await copyText(response.user_code);
      } catch (e) {
        console.debug("[ManagedAuth] Failed to copy user code:", e);
      }
      if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
        return;
      }

      try {
        await settingsApi.openExternal(response.verification_uri);
      } catch (e) {
        console.debug("[ManagedAuth] Failed to open browser:", e);
      }
      if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
        return;
      }

      // Add a small buffer on top of GitHub's suggested interval to avoid
      // hitting slow_down responses too aggressively during device polling.
      const interval = Math.max((response.interval || 5) + 3, 8) * 1000;
      const expiresAt = Date.now() + response.expires_in * 1000;

      let pollInFlight = false;
      const pollOnce = async () => {
        if (
          pollInFlight ||
          !mountedRef.current ||
          attemptGen !== attemptGenRef.current
        ) {
          if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
            stopPolling();
          }
          return;
        }
        if (Date.now() > expiresAt) {
          attemptGenRef.current += 1;
          stopPolling();
          setPollingState("error");
          setError("Device code expired. Please try again.");
          return;
        }

        pollInFlight = true;
        try {
          const newAccount = await authApi.authPollForAccount(
            authProvider,
            response.device_code,
            githubDomain,
          );
          if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
            return;
          }
          if (newAccount) {
            attemptGenRef.current += 1;
            stopPolling();
            setPollingState("success");
            await refetchStatus();
            await queryClient.invalidateQueries({ queryKey });
            if (!mountedRef.current) {
              return;
            }
            setPollingState("idle");
            setDeviceCode(null);
          }
        } catch (e) {
          if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
            return;
          }
          const errorMessage = e instanceof Error ? e.message : String(e);
          if (
            !errorMessage.includes("pending") &&
            !errorMessage.includes("slow_down")
          ) {
            attemptGenRef.current += 1;
            stopPolling();
            setPollingState("error");
            setError(errorMessage);
          }
        } finally {
          pollInFlight = false;
        }
      };

      void pollOnce();
      pollingIntervalRef.current = setInterval(pollOnce, interval);
      pollingTimeoutRef.current = setTimeout(() => {
        if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
          return;
        }
        attemptGenRef.current += 1;
        stopPolling();
        setPollingState("error");
        setError("Device code expired. Please try again.");
      }, response.expires_in * 1000);
    },
    onError: (e, attemptGen) => {
      if (!mountedRef.current || attemptGen !== attemptGenRef.current) {
        return;
      }
      setPollingState("error");
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => authApi.authLogout(authProvider),
    onSuccess: async () => {
      attemptGenRef.current += 1;
      stopPolling();
      if (!mountedRef.current) return;
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      queryClient.setQueryData(queryKey, {
        provider: authProvider,
        authenticated: false,
        default_account_id: null,
        accounts: [],
      });
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: async (e) => {
      if (!mountedRef.current) return;
      console.error("[ManagedAuth] Failed to logout:", e);
      setError(e instanceof Error ? e.message : String(e));
      await refetchStatus();
    },
  });

  const removeAccountMutation = useMutation({
    mutationFn: (accountId: string) =>
      authApi.authRemoveAccount(authProvider, accountId),
    onSuccess: async () => {
      attemptGenRef.current += 1;
      stopPolling();
      if (!mountedRef.current) return;
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      await refetchStatus();
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      if (!mountedRef.current) return;
      console.error("[ManagedAuth] Failed to remove account:", e);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const setDefaultAccountMutation = useMutation({
    mutationFn: (accountId: string) =>
      authApi.authSetDefaultAccount(authProvider, accountId),
    onSuccess: async () => {
      await refetchStatus();
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      if (!mountedRef.current) return;
      console.error("[ManagedAuth] Failed to set default account:", e);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const startAuth = useCallback(() => {
    const attemptGen = ++attemptGenRef.current;
    stopPolling();
    setPollingState("idle");
    setDeviceCode(null);
    setError(null);
    startLoginMutation.mutate(attemptGen);
  }, [startLoginMutation, stopPolling]);

  const cancelAuth = useCallback(() => {
    attemptGenRef.current += 1;
    stopPolling();
    setPollingState("idle");
    setDeviceCode(null);
    setError(null);
  }, [stopPolling]);

  const logout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  const removeAccount = useCallback(
    (accountId: string) => {
      removeAccountMutation.mutate(accountId);
    },
    [removeAccountMutation],
  );

  const setDefaultAccount = useCallback(
    (accountId: string) => {
      setDefaultAccountMutation.mutate(accountId);
    },
    [setDefaultAccountMutation],
  );

  const accounts = authStatus?.accounts ?? [];

  return {
    authStatus,
    isLoadingStatus,
    accounts,
    hasAnyAccount: accounts.length > 0,
    isAuthenticated: authStatus?.authenticated ?? false,
    defaultAccountId: authStatus?.default_account_id ?? null,
    migrationError: authStatus?.migration_error ?? null,
    pollingState,
    deviceCode,
    error,
    isPolling: pollingState === "polling",
    isAddingAccount: startLoginMutation.isPending || pollingState === "polling",
    isRemovingAccount: removeAccountMutation.isPending,
    isSettingDefaultAccount: setDefaultAccountMutation.isPending,
    startAuth,
    addAccount: startAuth,
    cancelAuth,
    logout,
    removeAccount,
    setDefaultAccount,
    refetchStatus,
  };
}
