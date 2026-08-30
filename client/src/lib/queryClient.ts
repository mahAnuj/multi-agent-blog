import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { createApiUrl } from "./config";
import { authHeaders, clearAdminToken } from "./admin-token";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const fullUrl = createApiUrl(url);
  const res = await fetch(fullUrl, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  // A rejected token is stale - drop it so the UI falls back to signed out.
  if (res.status === 401) clearAdminToken();

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    // Handle the case where queryKey might contain objects
    const url = typeof queryKey[0] === 'string' && queryKey[0].startsWith('/') 
      ? queryKey[0] 
      : queryKey.filter(key => typeof key === 'string').join("/");
    
    const fullUrl = createApiUrl(url as string);
    const res = await fetch(fullUrl, {
      credentials: "include",
      headers: authHeaders(),
    });

    if (res.status === 401) {
      clearAdminToken();
      if (unauthorizedBehavior === "returnNull") return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
