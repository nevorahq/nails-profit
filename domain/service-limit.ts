/**
 * How many services one sitting may hold.
 *
 * A visit is one client in one chair: ten services in it is a typo, not a
 * client. Shared by the API that refuses more and the screens that stop
 * offering «+ ещё услуга», so the two cannot disagree.
 */
export const MAX_SERVICES = 10;

/**
 * The same, for a client booking on the public page.
 *
 * Three covers the combinations people actually book — hands, feet, brows —
 * while a stranger's one request cannot take a master's whole afternoon. The
 * studio's own calendar keeps the larger limit: there it is somebody who knows
 * the client deciding.
 */
export const MAX_PUBLIC_SERVICES = 3;
