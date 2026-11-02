/**
 * Downloads the real library files from the private "content" bucket so the
 * extraction spike can run locally. Requires either:
 *   - SUPABASE_SERVICE_ROLE_KEY (local admin download), or
 *   - LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD for an allowed member account.
 * Usage: bun scripts/download-library.ts [outputDir]
 *
 * The service role is used only by this local script (and later the ingestion
 * Edge Function). Never expose it to the browser or commit it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Database } from "../src/integrations/supabase/types";
import { documentFormat } from "../src/lib/document-format";

const BUCKET = "content";
const SUPPORTED = new Set(["pdf", "docx", "pptx"]);

type ManifestEntry = {
  localPath: string;
  id: string;
  title: string;
  fileName: string;
  filePath: string;
  fileSize: number | null;
  industry: string;
  customerName: string | null;
  mimeType: string | null;
};

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const email = process.env.LIBRARY_USER_EMAIL;
  const password = process.env.LIBRARY_USER_PASSWORD;

  if (!url) {
    console.error("Missing SUPABASE_URL.");
    process.exitCode = 1;
    return;
  }

  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  let supabase: SupabaseClient<Database>;

  if (serviceKey) {
    supabase = createClient<Database>(url, serviceKey, options);
    console.log("Using the service role for this local download.");
  } else if (publishableKey && email && password) {
    supabase = createClient<Database>(url, publishableKey, options);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      console.error(`Could not sign in as ${email}: ${signInError.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Signed in as ${email}; RLS applies.`);
  } else {
    console.error("Missing credentials.");
    console.error(
      "Set SUPABASE_SERVICE_ROLE_KEY, or LIBRARY_USER_EMAIL + LIBRARY_USER_PASSWORD for an allowed member account.",
    );
    console.error('The publishable key alone cannot read the private "content" bucket (RLS).');
    process.exitCode = 1;
    return;
  }

  const outputDir = resolve(process.argv[2] ?? "spike-input");

  const { data, error } = await supabase
    .from("content_items")
    .select("id,title,file_name,file_path,file_size,mime_type,industry,customer_name")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`Could not read content_items: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const items = data ?? [];
  if (items.length === 0) {
    console.log("No content_items are visible to this session; check the email domain and RLS.");
  }
  const supported = items.filter((item) =>
    SUPPORTED.has(documentFormat(item.file_name, item.mime_type ?? "")),
  );

  // Move/copy can point several rows at one stored object.
  const unique = new Map<string, (typeof supported)[number]>();
  for (const item of supported) {
    if (!unique.has(item.file_path)) unique.set(item.file_path, item);
  }

  const manifest: ManifestEntry[] = [];
  const failures: Array<{ filePath: string; error: string }> = [];
  let downloaded = 0;
  let skipped = 0;

  for (const item of unique.values()) {
    const safeName = item.file_name.replace(/[^\w.-]+/g, "_");
    const localPath = join(outputDir, `${item.id.slice(0, 8)}-${safeName}`);
    const existingSize = existsSync(localPath) ? statSync(localPath).size : -1;
    const alreadyComplete =
      existingSize >= 0 &&
      (item.file_size === null ? existingSize > 0 : existingSize === item.file_size);

    if (alreadyComplete) {
      skipped += 1;
      manifest.push({
        localPath,
        id: item.id,
        title: item.title,
        fileName: item.file_name,
        filePath: item.file_path,
        fileSize: item.file_size,
        industry: item.industry,
        customerName: item.customer_name,
        mimeType: item.mime_type,
      });
      continue;
    }

    const { data: blob, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(item.file_path);
    if (downloadError || !blob) {
      failures.push({
        filePath: item.file_path,
        error: downloadError?.message ?? "empty download",
      });
      continue;
    }

    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, new Uint8Array(await blob.arrayBuffer()));
    downloaded += 1;
    manifest.push({
      localPath,
      id: item.id,
      title: item.title,
      fileName: item.file_name,
      filePath: item.file_path,
      fileSize: item.file_size,
      industry: item.industry,
      customerName: item.customer_name,
      mimeType: item.mime_type,
    });
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, "manifest.json"),
    `${JSON.stringify({ bucket: BUCKET, downloaded: manifest, failures }, null, 2)}\n`,
  );

  console.log(
    `Downloaded ${downloaded}, skipped ${skipped} already complete, ${manifest.length} of ${unique.size} supported files in ${outputDir}/`,
  );
  console.log(`Skipped ${items.length - supported.length} image/video/unsupported items.`);
  for (const failure of failures) {
    console.error(`FAILED ${failure.filePath}: ${failure.error}`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

void main();
