import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { redirectOnPasswordChange } from "@/lib/auth/password-change";

export const queryClient = new QueryClient({
  // Synelia fork: a 403 password_change_required from any call sends the app to /change-password.
  queryCache: new QueryCache({
    onError: (error) => redirectOnPasswordChange(error),
  }),
  mutationCache: new MutationCache({
    onError: (error) => redirectOnPasswordChange(error),
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
