import { App } from "@/components/App";
import { listRepositories } from "@/lib/repos";

// Reads the index on every request. The repository list changes as background
// indexing progresses, so a cached page would show stale progress.
export const dynamic = "force-dynamic";

/**
 * Server shell.
 *
 * The repository list is read straight from Postgres and handed to the client as
 * initial state, so the first paint already shows what is indexed instead of
 * an empty sidebar that fills in a moment later. The client takes over from
 * there and polls only while something is actually indexing.
 */
export default async function Page() {
  return <App initialRepos={await listRepositories()} />;
}
