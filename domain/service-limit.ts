/**
 * How many services one sitting may hold.
 *
 * A visit is one client in one chair: ten services in it is a typo, not a
 * client. Shared by the API that refuses more and the screens that stop
 * offering «+ ещё услуга», so the two cannot disagree.
 */
export const MAX_SERVICES = 10;
