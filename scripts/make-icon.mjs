#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og.js";

/**
 * Draws the tab icon: the product's initials in the product's own typeface.
 *
 * Run once and committed, rather than generated per request from `app/icon.tsx`.
 * A favicon is the same two letters forever, so rendering it on a server that
 * has to keep a font file in its bundle buys nothing — and the file this reads
 * is 30 KB of Onest that would otherwise ship to production to redraw a
 * 512-pixel square nobody asked to change.
 *
 * Onest is the interface font (`app/layout.tsx`), licensed SIL OFL, kept beside
 * this script so the icon can be redrawn from source rather than edited as a
 * picture.
 *
 *   node scripts/make-icon.mjs
 */
const SIZE = 512;

// The interface palette, `app/globals.css`: the darkest green on a tab of any
// colour, with the paper tone the app itself is written on.
const INK = "#0f2a1d";
const PAPER = "#e3eed4";

const font = await readFile(join(process.cwd(), "scripts", "fonts", "Onest-Bold.ttf"));

const image = new ImageResponse(
  {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: INK,
        color: PAPER,
        // A tab shows the icon at 16 pixels, where a rounded square reads as a
        // shape and the corners are the only thing keeping it off the edges.
        borderRadius: `${SIZE * 0.22}px`,
        fontFamily: "Onest",
        fontWeight: 700,
        // Tight enough that two letters fill the square rather than float in it.
        fontSize: SIZE * 0.52,
        letterSpacing: `-${SIZE * 0.02}px`,
        // The cap height sits above the optical centre; nudged down so the
        // letters look centred rather than measured as centred.
        paddingTop: SIZE * 0.02,
      },
      children: "NP",
    },
  },
  {
    width: SIZE,
    height: SIZE,
    fonts: [{ name: "Onest", data: font, weight: 700, style: "normal" }],
  },
);

const png = Buffer.from(await image.arrayBuffer());
await writeFile(join(process.cwd(), "app", "icon.png"), png);
await writeFile(join(process.cwd(), "app", "apple-icon.png"), png);

console.log(`icon.png and apple-icon.png written, ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB`);
