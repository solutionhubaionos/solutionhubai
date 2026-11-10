<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

## Project rules

- Content grids render in incremental batches through ProgressiveList keyed by filters; Insights activity pages live in URL search, and file triggers reuse FilePreviewDialog to preserve private viewing and activity logging. File tiles use a full-area preview button behind non-interactive content, with separate action buttons above it to avoid nested controls.
- Bundled photos use WebP; document engines load on demand and PDFs retain one parsed document across page changes to reduce repeated work.
- User changes and sign-out clear query caches; short explicit freshness windows avoid repeated unchanged metadata reads without bypassing RLS.
- Usage insights verify is_content_admin before route entry and aggregate through an admin-checked database RPC; raw identity-bearing activity is visible only to its owner or verified admins.
- Recovery redirects use an exact origin allowlist; persistent atomic quotas guard account recovery and paid cover generation, and accounts are not auto-confirmed before mailbox verification.
- Library search keeps typed text in local state and saves its URL on blur or Enter, so asynchronous navigation cannot drop keystrokes.
- The admin dashboard verifies access with is_content_admin before loading paginated file metadata; deletions remain enforced by existing database and Storage policies, and storage totals deduplicate file paths and flag unknown sizes rather than estimate.
- Uploads on an industry page derive the destination slug from the current route, never retained form state; industry page local state resets on slug changes to prevent cross-folder assignments.
- File previews download through authenticated Storage into revocable browser blob URLs; PDF uses dynamically imported PDF.js and DOCX/PPTX use browser renderers inside script-disabled frames, never external hosted document viewers.
- Roles are stored in protected user_roles rows and enforced by RLS; client role queries only control presentation. Verified designated admin assignment runs on auth lifecycle events, while all users receive member grants.
- Company rename/delete uses an admin-checked transactional database RPC to update both saved companies and content labels; deleting a company preserves its files as industry-wide content.
- The page logo and browser/touch icons derive from the same bundled brand asset so the app identity stays consistent.
- Allowed email domains live in `src/lib/domains.ts` and are mirrored in the DB function `public.is_allowed_email` (trigger on auth.users + RLS); change both together — the DB is the real gate.
- First-time access and forgot-password share one server function (`requestPasswordLink`) that pre-creates the user then emails a recovery link; there is no public signup.
- Industries live in the `industries` table (anyone can read, allowed users add). The original 8 use bundled images keyed by slug; new ones get an AI-generated cover stored in the private `industry-images` bucket and served via `/api/public/industry-image/$slug` (public buckets are blocked in this workspace). Customers per industry = rows in `customers` table merged with names used in `content_items.customer_name`.
