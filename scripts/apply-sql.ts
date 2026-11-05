/**
 * Applies explicit SQL migration files in order, all inside one transaction.
 * Usage: bun scripts/apply-sql.ts --all
 *        bun scripts/apply-sql.ts drizzle/migrations/0012_foo.sql
 *        bun scripts/apply-sql.ts --dry-run drizzle/migrations/0010_rag.sql
 *
 * --dry-run executes every file and then rolls the transaction back, so you can
 * check a production migration without committing anything.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const dir = "drizzle/migrations";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const files = args.includes("--all")
  ? readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => join(dir, file))
  : args.filter((arg) => arg !== "--all" && arg !== "--dry-run");

if (!process.env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is missing from .env");
  process.exit(1);
}

if (files.length === 0) {
  console.error("Pass SQL files to apply, or --all for a fresh database.");
  process.exit(1);
}

const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1, prepare: false });

try {
  await sql.begin(async (tx) => {
    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      await tx.unsafe(contents);
      console.log(`${dryRun ? "checked" : "applied"} ${file}`);
    }
    if (dryRun) throw new Error("__DRY_RUN__");
  });
  console.log(`done: ${files.length} file(s)`);
} catch (error) {
  if (error instanceof Error && error.message === "__DRY_RUN__") {
    console.log(`dry run: ${files.length} file(s) applied, then rolled back; nothing committed`);
  } else {
    console.error("migration failed, transaction rolled back");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
