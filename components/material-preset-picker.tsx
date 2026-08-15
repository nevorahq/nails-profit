"use client";

import { useState, type MouseEvent } from "react";

import {
  addOnMaterialPresets,
  serviceMaterialPresets,
  type SystemMaterialPresetTarget,
} from "@/domain/material-presets";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import type { MaterialRow } from "@/lib/materials";

/**
 * Copies a product-owned estimate into the visible recipe form. Nothing is
 * persisted until the owner reviews the quantities and presses the form's
 * normal save button, which creates the usual organization recipe version.
 */
export function MaterialPresetPicker({
  target,
  materials,
  locale,
}: {
  target: SystemMaterialPresetTarget;
  materials: MaterialRow[];
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const presets = target === "service" ? serviceMaterialPresets : addOnMaterialPresets;
  const [selected, setSelected] = useState("");

  function apply(event: MouseEvent<HTMLButtonElement>) {
    const preset = presets.find((candidate) => candidate.key === selected);
    const form = event.currentTarget.form;
    if (!preset || !form) return;

    for (const material of materials) {
      const input = form.elements.namedItem(`qty-${material.id}`);
      if (!(input instanceof HTMLInputElement)) continue;
      const quantity = material.system_key ? preset.items[material.system_key] : undefined;
      input.value = quantity === undefined ? "" : String(quantity / 1000);
    }
  }

  return (
    <div className="preset-picker">
      <div className="inline-form">
        <label>
          {t("services.systemPreset")}
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">{t("services.systemPresetPlaceholder")}</option>
            {presets.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.label[locale]}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-button" type="button" disabled={!selected} onClick={apply}>
          {t("services.applyPreset")}
        </button>
      </div>
      <p className="muted">{t("services.presetEstimateNote")}</p>
    </div>
  );
}
