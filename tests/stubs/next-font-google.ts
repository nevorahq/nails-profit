/**
 * `next/font/google` is compiled away by Next's own loader, so under plain
 * Node it is a module whose exports are not functions. A component that only
 * needs the font's CSS class — `components/auth-shell.tsx` — then fails to
 * import in a unit test for a reason that has nothing to do with what the test
 * checks. These return what the real call would: a class name and a variable,
 * both empty here because no stylesheet is being loaded.
 */
const font = () => ({ className: "", variable: "", style: { fontFamily: "" } });

export const Lora = font;
export const Onest = font;
