/**
 * A stand-in for something expensive that should not be built at import time.
 *
 * The reason it exists is a deploy that failed: `next build` collects page data
 * by loading every route's module graph, the root layout reads the
 * organization's language, and that pulled in the database handle and the auth
 * instance — both of which validated production secrets while being
 * constructed. The 404 page could not be prerendered without a
 * `DATABASE_URL`. Nothing about a 404 page needs one.
 *
 * Deferring construction also puts the error where it belongs. A missing
 * variable now surfaces on the request that needed it, naming that request,
 * rather than on whichever module the bundler happened to load first.
 */
export function lazyProxy<T extends object>(resolve: () => T, callable = false): T {
  // A callable target is needed for anything used as a function — the postgres
  // client is a tagged template, and a Proxy can only be applied if its target
  // can be.
  const target = (callable ? function placeholder() {} : {}) as T;

  return new Proxy(target, {
    apply(_target, thisArg, argumentsList) {
      const source = resolve() as unknown as (...args: unknown[]) => unknown;
      return Reflect.apply(source, thisArg, argumentsList);
    },
    get(_target, property) {
      const source = resolve();
      const value = Reflect.get(source, property) as unknown;
      // Bound to the real object rather than to the proxy, so a method that
      // uses `this` — `db.transaction`, `auth.api` — still works.
      return typeof value === "function" ? value.bind(source) : value;
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), property);
      // A proxy may only report a property as configurable if the target agrees,
      // and the target here is empty; without this, `Object.keys` throws.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
