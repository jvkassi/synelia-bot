import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Synelia fork: a 404 will not become a 200 by asking again (pilot-hidden route, gone row).
      retry: (failureCount, error) =>
        (error as { status?: number } | null)?.status !== 404 &&
        failureCount < 1,
      refetchOnWindowFocus: false,
    },
  },
});
