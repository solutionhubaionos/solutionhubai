/**
 * Server function: stop a running request by id. The Stop button calls this, so
 * the server aborts the in-flight work instead of finishing it and discarding
 * the result.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cancelRequest } from "./cancel";

export const stopRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ requestId: z.string().uuid() }).parse(data))
  .handler(async ({ data }): Promise<{ ok: boolean }> => ({ ok: cancelRequest(data.requestId) }));
