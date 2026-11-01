type Route = { page: string; resourceId?: string };
type Location<RouteType extends Route> = { route: RouteType; hash: string };

/** Check before the app changes its route; restoring a hash after setRoute would already unmount the editor. */
export function applyHashNavigation<RouteType extends Route>(current: Location<RouteType>, next: Location<RouteType>, options: {
  hasUnsavedProduction: boolean;
  hasUnsavedNovel?: boolean;
  hasUnsavedAssets?: boolean;
  hasUnsavedModelConnections?: boolean;
  hasUnsavedAutomation?: boolean;
  confirmLeave: () => boolean;
  restoreHash: (hash: string) => void;
  commitRoute: (route: RouteType) => void;
}): Location<RouteType> {
  const leavingDirtyEditor = (current.route.page === 'production' && options.hasUnsavedProduction)
    || (current.route.page === 'novel' && options.hasUnsavedNovel)
    || (current.route.page === 'assets' && options.hasUnsavedAssets)
    || (current.route.page === 'settings' && current.route.resourceId === 'models' && options.hasUnsavedModelConnections)
    || (current.route.page === 'automation' && options.hasUnsavedAutomation);
  const changingEditor = current.route.page !== next.route.page || current.route.resourceId !== next.route.resourceId;
  if (changingEditor && leavingDirtyEditor && !options.confirmLeave()) {
    options.restoreHash(current.hash);
    return current;
  }
  options.commitRoute(next.route);
  return next;
}
