-- Remove the per-client brand cache.
--
-- Client branding (colours, fonts, logo) was removed from the product: decks
-- always render with the fixed house theme. The `brand_profiles` cache is no
-- longer read or written, so drop it. `conversations.target_client` stays: it
-- still holds the pitched client's name, website URL and industry, which the
-- deck uses for grounding and logo detection.
set search_path = public;

drop table if exists public.brand_profiles;
