"use client";

import { createContext, useContext, type ReactNode } from "react";

import { writtenRegister, type Register } from "@/i18n/lexicon";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type Translate } from "@/i18n/t";

/**
 * Who the client components inside a workspace are talking to.
 *
 * Server pages pass the register to `getTranslator` themselves; the components
 * under them receive only a locale as a prop, as they always have, and read
 * the rest from here. Outside a workspace there is no provider, and the
 * default is the dictionary as written.
 */
const LexiconContext = createContext<Register>(writtenRegister);

export function LexiconProvider({ register, children }: { register: Register; children: ReactNode }) {
  return <LexiconContext.Provider value={register}>{children}</LexiconContext.Provider>;
}

export function useRegister(): Register {
  return useContext(LexiconContext);
}

export function useTranslator(locale: AppLocale): Translate {
  return getTranslator(locale, useContext(LexiconContext));
}
