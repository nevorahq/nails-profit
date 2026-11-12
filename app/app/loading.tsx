import { RouteLoadingLabel } from "@/components/route-loading-label";

/**
 * What a section of /app shows between the click and its data.
 *
 * Every page under /app reads the database before it can draw anything, and
 * the database is an ocean away from the functions, so a page is one to three
 * seconds of waiting. Without this file that wait was invisible: Next does not
 * prefetch a dynamic page that has no loading boundary, and a click left the old
 * screen in place, the link unlit and the address unchanged, until the whole of
 * the new page had arrived. It read as a click that had not registered, and
 * people clicked again.
 *
 * With it, Next prefetches everything down to this boundary while the link is
 * still on screen, so a click swaps the content for this skeleton at once — the
 * sidebar, the topbar title and the active link change with it, because they
 * live in the layout above — and the page streams in over it. The layout itself
 * is shared between sections and is not rendered again on such a click, which
 * is why the session and membership it reads do not hold the skeleton back.
 *
 * It has to stay static to be prefetched: no request data, no database, no
 * translation lookup on the server. The one word it says is chosen in the
 * browser from the page's own language — see `RouteLoadingLabel`.
 */
export default function AppLoading() {
  /*
   * A `div`, not a `main`: while a full page load streams, the skeleton and the
   * page that replaces it are in the document together for a moment, and two
   * `main` landmarks would tell a screen reader there are two pages — and
   * make every `getByRole("main")` ambiguous.
   */
  return (
    <div className="app-shell route-loading" aria-busy="true">
      <RouteLoadingLabel />
      <span className="route-loading-bar route-loading-title" aria-hidden="true" />
      <div className="route-loading-cards" aria-hidden="true">
        <span className="route-loading-bar" />
        <span className="route-loading-bar" />
        <span className="route-loading-bar" />
      </div>
      <span className="route-loading-bar route-loading-panel" aria-hidden="true" />
    </div>
  );
}
