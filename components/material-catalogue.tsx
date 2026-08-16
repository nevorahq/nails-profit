"use client";

import { FormEvent, Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

import type { MaterialCostingMode } from "@/domain/material-pricing";
import { fromMilliUnits } from "@/domain/units";
import type { MaterialStockRow } from "@/lib/material-stock";
import { NameCombobox } from "@/components/name-combobox";
import type { MaterialTemplateRow } from "@/lib/material-templates";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";
import type { MaterialRow } from "@/lib/materials";

type PriceDraft = {
  materialId: string;
  mode: MaterialCostingMode;
  price: string;
  divisor: string;
  currency: "MDL" | "EUR";
};

type PurchaseDraft = {
  materialId: string;
  quantity: string;
  size: string;
  price: string;
  supplier: string;
  purchasedAt: string;
};

type StockCheckDraft = {
  materialId: string;
  /** Share of one package, the only form a person can answer without a scale. */
  share: number | null;
  exact: string;
};

/**
 * The five answers the stock question offers, section 38.
 *
 * Buckets rather than a number field, because the honest input here is a
 * glance at a bottle. The share is of one package: the screen knows which
 * package the material is priced in, so it can turn "≈half" into millilitres
 * before it reaches the server, which stores nothing but the quantity.
 */
const STOCK_BUCKETS: readonly { share: number; key: MessageKey }[] = [
  { share: 0.05, key: "materials.bucketEmpty" },
  { share: 0.25, key: "materials.bucketQuarter" },
  { share: 0.5, key: "materials.bucketHalf" },
  { share: 0.75, key: "materials.bucketThreeQuarters" },
  { share: 0.95, key: "materials.bucketFull" },
];

type MaterialDraft = {
  id: string;
  name: string;
  unit: string;
};

type CatalogueSuggestionSource = Pick<
  MaterialRow,
  "id" | "name" | "system_key" | "base_unit" | "current_price"
>;

type MaterialSuggestion = {
  key: string;
  /** The tenant's own material, when this ingredient is already in the catalogue. */
  materialId: string | null;
  /** The curated row it came from; null once the owner types a name of their own. */
  templateId: string | null;
  name: string;
  brand: string | null;
  baseUnit: "ml" | "g" | "piece";
  category: string;
  /** Prefilled from the template, so the owner only supplies the price. */
  packageSizeMilliUnits: number | null;
  kind: "sku" | "aggregate";
};

/** The dashboard's onboarding step links here to add a first material. */
const ADD_FORM_HASH = "#add-material";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const modes: readonly MaterialCostingMode[] = [
  "quantity",
  "services_per_package",
  "fixed_per_service",
];

function normalizedMaterialName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\u0451/g, "\u0435");
}

/**
 * The catalogue rows worth offering: everything the owner has not already
 * priced.
 *
 * The fixed system catalogue is 85 generic materials in 11 groups. Picking one
 * fills in the name and the unit — the two things that never vary — and leaves
 * the package size and the price to the owner, because "База" is sold in four
 * different bottles and the catalogue does not know which one is on the table.
 */
export function availableMaterialSuggestions(
  materials: readonly CatalogueSuggestionSource[],
  templates: readonly MaterialTemplateRow[],
  query: string,
): MaterialSuggestion[] {
  const normalizedQuery = normalizedMaterialName(query);
  const materialsBySystemKey = new Map(
    materials.flatMap((material) =>
      material.system_key ? [[material.system_key, material] as const] : [],
    ),
  );

  return templates.flatMap((template) => {
    const existing = template.system_key
      ? materialsBySystemKey.get(template.system_key)
      : undefined;
    // Already priced: suggesting it again would offer the owner a second copy
    // of a material the natural key would then refuse.
    if (existing?.current_price) return [];

    const suggestion: MaterialSuggestion = {
      key: template.slug,
      materialId: existing?.id ?? null,
      templateId: template.id,
      name: existing?.name ?? displayTemplateName(template),
      brand: template.brand,
      category: template.category,
      baseUnit: (existing?.base_unit ?? template.base_unit) as MaterialSuggestion["baseUnit"],
      packageSizeMilliUnits: template.package_size_milli_units,
      kind: template.kind,
    };

    return normalizedQuery === "" ||
      normalizedMaterialName(suggestion.name).includes(normalizedQuery)
      ? [suggestion]
      : [];
  });
}

export function displayTemplateName(
  template: Pick<MaterialTemplateRow, "brand" | "name">,
): string {
  return template.brand ? `${template.brand} ${template.name}` : template.name;
}

/**
 * Where a submitted form goes, and with what.
 *
 * Three destinations, because the owner is doing three different things:
 * pricing a material they already have, building one from a catalogue row, or
 * describing one the catalogue has never heard of. The middle case goes through
 * `from-templates` rather than the plain create so the material records where it
 * came from and inherits the template's packaging — which is the whole reason
 * choosing a template means typing one field instead of five.
 */
export function buildMaterialSubmitRequest({
  selectedMaterial,
  name,
  baseUnit,
  costingMode,
  pricePayload,
  currency = "MDL",
}: {
  selectedMaterial: MaterialSuggestion | null;
  name: FormDataEntryValue | null;
  baseUnit: string;
  costingMode: MaterialCostingMode;
  pricePayload: Record<string, number>;
  currency?: "MDL" | "EUR";
}): { url: string; body: Record<string, unknown>; headers?: Record<string, string> } {
  const existingMaterialId = selectedMaterial?.materialId;

  if (existingMaterialId) {
    return {
      url: `/api/v1/materials/${existingMaterialId}/prices`,
      body: { currency, costing_mode: costingMode, ...pricePayload },
    };
  }

  if (selectedMaterial?.templateId && costingMode === "quantity") {
    return {
      url: "/api/v1/materials/from-templates",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: {
        items: [
          {
            template_id: selectedMaterial.templateId,
            package_price_minor: pricePayload.package_price_minor,
            // The catalogue states no packaging, so the owner's figure travels
            // with the request. Converted here rather than sent as a decimal:
            // the schema stores thousandths, and `package_size` is what the
            // plain create endpoint takes.
            package_size_milli_units: Math.round(pricePayload.package_size * 1000),
            currency,
          },
        ],
      },
    };
  }

  return {
    url: "/api/v1/materials",
    body: {
      name,
      base_unit: baseUnit,
      category: selectedMaterial?.category,
      costing_mode: costingMode,
      ...pricePayload,
    },
  };
}

export function MaterialCatalogue({
  materials,
  templates,
  stock,
  locale,
  canManage,
}: {
  materials: MaterialRow[];
  templates: readonly MaterialTemplateRow[];
  /** Empty for a workspace that has never recorded a purchase; the column then reads «нет данных». */
  stock: readonly MaterialStockRow[];
  locale: AppLocale;
  canManage: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const tag = localeTag(locale);
  const addRef = useRef<HTMLDivElement>(null);

  /**
   * The form is open when the URL asks for it, or when the owner said so.
   *
   * Read through `useSyncExternalStore` rather than seeded into `useState`,
   * because `location` does not exist on the server: an initializer that reads
   * the hash makes the first client render disagree with the server's, and
   * React throws the markup away on every reload of
   * `/app/materials#add-material` — which is exactly the link the onboarding
   * step points at.
   */
  const hashWantsForm = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash === ADD_FORM_HASH,
    () => false,
  );
  const [toggled, setToggled] = useState<boolean | null>(null);
  const addOpen = toggled ?? hashWantsForm;
  const [addMode, setAddMode] = useState<MaterialCostingMode>("quantity");
  const [addName, setAddName] = useState("");
  const [addUnit, setAddUnit] = useState("ml");
  /**
   * The package size, seeded from the catalogue when a row is chosen.
   *
   * Controlled rather than left to the DOM, because choosing a template has to
   * be able to fill it — and the owner has to be able to overwrite it in place.
   * The catalogue states the packaging these materials usually come in; the one
   * on the table is the one the cost must divide by.
   */
  const [addDivisor, setAddDivisor] = useState("");
  const [selectedMaterial, setSelectedMaterial] = useState<MaterialSuggestion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MaterialDraft | null>(null);
  const [pricing, setPricing] = useState<PriceDraft | null>(null);
  const [purchasing, setPurchasing] = useState<PurchaseDraft | null>(null);
  const [checking, setChecking] = useState<StockCheckDraft | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  const stockByMaterial = new Map(stock.map((row) => [row.material_id, row]));
  // One place the table's width is decided, so a new column cannot leave an
  // editor row spanning the wrong number of cells.
  const columnCount = canManage ? 5 : 4;

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const trigger = (event.target as HTMLElement).closest(`a[href="${ADD_FORM_HASH}"]`);
      if (!trigger) return;
      event.preventDefault();
      setToggled((current) => !(current ?? window.location.hash === ADD_FORM_HASH));
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (addOpen) addRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.querySelectorAll<HTMLAnchorElement>('a.header-action[href="#add-material"]').forEach((button) => {
      const label = addOpen ? button.dataset.labelOpen : button.dataset.labelClosed;
      if (label) button.setAttribute("aria-label", label);
    });
  }, [addOpen]);

  async function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const price = String(data.get("price") ?? "").trim();
    const divisor = String(data.get("divisor") ?? "").trim();
    const pricePayload = buildPricePayload(addMode, price, divisor, selectedMaterial !== null);
    if (pricePayload === null) {
      setError(t("materials.completePrice"));
      setPending(false);
      return;
    }

    const request = buildMaterialSubmitRequest({
      selectedMaterial,
      name: data.get("name"),
      baseUnit: addUnit,
      costingMode: addMode,
      pricePayload,
    });
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      setError(await responseError(response, t("materials.saveFailed")));
      setPending(false);
      return;
    }

    form.reset();
    setAddName("");
    setAddUnit("ml");
    setAddDivisor("");
    setSelectedMaterial(null);
    setAddMode("quantity");
    setToggled(false);
    setPending(false);
    router.refresh();
  }

  function startMaterialEdit(material: MaterialRow) {
    setPricing(null);
    setConfirmArchive(null);
    setError(null);
    setEditing({ id: material.id, name: material.name, unit: material.base_unit });
  }

  function startPriceEdit(material: MaterialRow) {
    const current = material.current_price;
    setEditing(null);
    setConfirmArchive(null);
    setError(null);
    setPricing({
      materialId: material.id,
      mode: current?.costing_mode ?? "quantity",
      price: current ? String(current.package_price_minor / 100) : "",
      divisor:
        current && current.costing_mode !== "fixed_per_service"
          ? String(current.package_size_milli_units / 1000)
          : "",
      currency: current?.currency === "EUR" ? "EUR" : "MDL",
    });
  }

  async function saveMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/materials/${editing.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: editing.name.trim(), base_unit: editing.unit }),
    });

    if (!response.ok) {
      setError(await responseError(response, t("materials.editFailed")));
      setPending(false);
      return;
    }

    setEditing(null);
    setPending(false);
    router.refresh();
  }

  async function savePrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pricing) return;
    const pricePayload = buildPricePayload(pricing.mode, pricing.price, pricing.divisor, true);
    if (!pricePayload) {
      setError(t("materials.completePrice"));
      return;
    }

    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/materials/${pricing.materialId}/prices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        costing_mode: pricing.mode,
        currency: pricing.currency,
        ...pricePayload,
      }),
    });

    if (!response.ok) {
      setError(await responseError(response, t("materials.editFailed")));
      setPending(false);
      return;
    }

    setPricing(null);
    setPending(false);
    router.refresh();
  }

  function startPurchase(material: MaterialRow) {
    setEditing(null);
    setPricing(null);
    setChecking(null);
    setPurchasing({
      materialId: material.id,
      quantity: "1",
      // Prefilled from the packaging already on file, because buying the same
      // bottle again is the common case and the owner should only have to type
      // what changed — the price.
      size:
        material.current_price && material.current_price.costing_mode === "quantity"
          ? String(fromMilliUnits(material.current_price.package_size_milli_units))
          : "",
      price: "",
      supplier: "",
      purchasedAt: "",
    });
  }

  async function savePurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!purchasing) return;

    const quantity = Number(purchasing.quantity);
    const size = Number(purchasing.size);
    const amountMinor = Math.round(Number(purchasing.price) * 100);
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      !Number.isFinite(size) ||
      size <= 0 ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < 0
    ) {
      setError(t("materials.completePrice"));
      return;
    }

    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/materials/${purchasing.materialId}/purchases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        package_quantity: quantity,
        package_size: size,
        unit_package_cost_minor: amountMinor,
        ...(purchasing.supplier.trim() ? { supplier: purchasing.supplier.trim() } : {}),
        // A date-only field means midnight local time, which is what someone
        // entering last Tuesday's receipt means by it.
        ...(purchasing.purchasedAt
          ? { purchased_at: new Date(`${purchasing.purchasedAt}T12:00:00`).toISOString() }
          : {}),
      }),
    });

    if (!response.ok) {
      setError(await responseError(response, t("materials.purchaseFailed")));
      setPending(false);
      return;
    }

    setPurchasing(null);
    setPending(false);
    router.refresh();
  }

  function startStockCheck(material: MaterialRow) {
    setEditing(null);
    setPricing(null);
    setPurchasing(null);
    setChecking({ materialId: material.id, share: null, exact: "" });
  }

  async function saveStockCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!checking) return;

    const material = materials.find((row) => row.id === checking.materialId);
    const packageSize =
      material?.current_price && material.current_price.costing_mode === "quantity"
        ? fromMilliUnits(material.current_price.package_size_milli_units)
        : null;

    /*
     * A bucket is a share of one package, so it can only be answered when the
     * packaging is known. Without it the field falls back to a plain quantity —
     * a material priced per service has no bottle to be a quarter of.
     */
    const observed =
      checking.share !== null && packageSize !== null
        ? checking.share * packageSize
        : Number(checking.exact);

    if (!Number.isFinite(observed) || observed < 0) {
      setError(t("materials.stockCheckFailed"));
      return;
    }

    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/materials/${checking.materialId}/stock-checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        observed_quantity: Math.round(observed * 1000) / 1000,
        basis: checking.share !== null && packageSize !== null ? "bucket" : "measured",
      }),
    });

    if (!response.ok) {
      setError(await responseError(response, t("materials.stockCheckFailed")));
      setPending(false);
      return;
    }

    setChecking(null);
    setPending(false);
    router.refresh();
  }

  async function archiveMaterial(id: string) {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/materials/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setError(await responseError(response, t("materials.deleteFailed")));
      setPending(false);
      setConfirmArchive(null);
      return;
    }

    setConfirmArchive(null);
    setPending(false);
    router.refresh();
  }

  const missingPrice = materials.filter((material) => material.current_price === null).length;
  const materialSuggestions = availableMaterialSuggestions(materials, templates, addName);

  /*
   * Section 49: the overview leads with what needs doing, not with a table.
   * Only «low» and «out» qualify — a material nobody has recorded buying is
   * unknown rather than urgent, and listing every unknown would make the block
   * a second copy of the catalogue on the first day of use.
   */
  const needAttention = materials.flatMap((material) => {
    const row = stockByMaterial.get(material.id);
    return row && (row.status === "low" || row.status === "out") ? [{ material, row }] : [];
  });

  function chooseMaterialSuggestion(suggestion: MaterialSuggestion) {
    setAddName(suggestion.name);
    setAddUnit(suggestion.baseUnit);
    setSelectedMaterial(suggestion);
    // Choosing a catalogue row settles how it is costed: a package price over a
    // package size. The other two modes exist for materials nobody sells by
    // volume, and a catalogue row is sold by volume.
    setAddMode("quantity");
    // A default, not an answer: the owner sees 15 ml for a base coat and
    // changes it to 12 if that is the bottle they bought.
    setAddDivisor(
      suggestion.packageSizeMilliUnits === null
        ? ""
        : String(fromMilliUnits(suggestion.packageSizeMilliUnits)),
    );
  }

  return (
    <>
      {missingPrice > 0 && (
        <div className="warning-banner">
          {t("materials.missingPriceBanner", { count: missingPrice })}
        </div>
      )}

      {needAttention.length > 0 && (
        <section className="panel">
          <h2>{t("materials.attentionTitle")}</h2>
          <ul className="compact-list">
            {needAttention.map(({ material, row }) => (
              <li key={material.id}>
                <strong>{material.name}</strong>
                {" — "}
                {describeStock(row, t)}
              </li>
            ))}
          </ul>
          <p className="muted">{t("materials.attentionHint")}</p>
        </section>
      )}

      {canManage && (
        <div className={`compose-wrap${addOpen ? "" : " is-closed"}`} id="add-material" ref={addRef}>
          <div className="compose-inner">
            <section className="panel">
              <h2>
                {t(selectedMaterial?.materialId ? "materials.newPrice" : "materials.addMaterial")}
              </h2>
              <form className="inline-form" onSubmit={submitAdd}>
                <NameCombobox
                  id="material-name"
                  name="name"
                  label={t("materials.name")}
                  placeholder={t("materials.searchPlaceholder")}
                  title={t("materials.templateSearchTitle")}
                  emptyLabel={t("materials.noPopularSuggestions")}
                  footnote={t("materials.customNameHint")}
                  required
                  maxLength={200}
                  value={addName}
                  options={materialSuggestions.map((suggestion) => ({
                    key: suggestion.key,
                    label: suggestion.name,
                    group: suggestion.category,
                    hint: (
                      <>
                        {suggestion.packageSizeMilliUnits !== null
                          ? `${fromMilliUnits(suggestion.packageSizeMilliUnits)} ${t(`unit.${suggestion.baseUnit}` as MessageKey)}`
                          : t(`unit.${suggestion.baseUnit}` as MessageKey)}
                        {suggestion.kind === "aggregate" ? ` · ${t("materials.kind.aggregate")}` : ""}
                        {suggestion.materialId ? ` · ${t("materials.priceMissing")}` : ""}
                      </>
                    ),
                  }))}
                  onChange={(next) => {
                    setAddName(next);
                    setSelectedMaterial(null);
                  }}
                  onSelect={(option) => {
                    const suggestion = materialSuggestions.find(
                      (candidate) => candidate.key === option.key,
                    );
                    if (suggestion) chooseMaterialSuggestion(suggestion);
                  }}
                />
                <UnitField
                  t={t}
                  value={addUnit}
                  onChange={setAddUnit}
                  disabled={selectedMaterial !== null}
                />
                <ModeField
                  value={addMode}
                  onChange={(mode) => {
                    setAddMode(mode);
                    setAddDivisor("");
                  }}
                  t={t}
                />
                <PriceFields
                  mode={addMode}
                  t={t}
                  divisor={addDivisor}
                  onDivisor={setAddDivisor}
                />
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending
                    ? t("common.saving")
                    : t(selectedMaterial?.materialId ? "common.save" : "common.add")}
                </button>
              </form>
            </section>
          </div>
        </div>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}

      <table className="data-table materials-table">
        <thead>
          <tr>
            <th>{t("common.material")}</th>
            <th>{t("materials.costingMode")}</th>
            <th>{t("materials.currentPrice")}</th>
            <th>{t("materials.stock")}</th>
            {canManage && <th>{t("materials.actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {materials.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="muted">{t("materials.none")}</td>
            </tr>
          )}
          {materials.map((material) => (
            <Fragment key={material.id}>
              <tr>
                <td>
                  <strong>{material.name}</strong>
                  <span className="unit-hint">{t(`unit.${material.base_unit}` as MessageKey)}</span>
                  {/* E3.1 §F5: provenance is on the card permanently, not only
                      while the material is being created. Someone deciding a
                      price from this number should be able to see where the
                      number came from at the moment they are looking at it. */}
                  <span className="material-badge" title={t("materials.sourceLabel")}>
                    {t(`materials.source.${material.source}` as MessageKey)}
                  </span>
                  {material.kind === "aggregate" && (
                    <span className="material-badge" title={t("materials.kindAggregateHint")}>
                      {t("materials.kind.aggregate")}
                    </span>
                  )}
                </td>
                <td>
                  {material.current_price
                    ? t(modeKey(material.current_price.costing_mode))
                    : "—"}
                </td>
                <td>{renderCurrentPrice(material, tag, t)}</td>
                <td>{renderStock(stockByMaterial.get(material.id), material, tag, t)}</td>
                {canManage && (
                  <td className="material-actions">
                    <button className="inline-action" type="button" disabled={pending} onClick={() => startMaterialEdit(material)}>
                      {t("materials.edit")}
                    </button>
                    <button className="inline-action" type="button" disabled={pending} onClick={() => startPriceEdit(material)}>
                      {t("materials.newPrice")}
                    </button>
                    <button className="inline-action" type="button" disabled={pending} onClick={() => startPurchase(material)}>
                      {t("materials.purchase")}
                    </button>
                    <button className="inline-action" type="button" disabled={pending} onClick={() => startStockCheck(material)}>
                      {t("materials.stockCheck")}
                    </button>
                    {confirmArchive === material.id ? (
                      <>
                        <button className="inline-action danger" type="button" disabled={pending} onClick={() => archiveMaterial(material.id)}>
                          {t("materials.archiveConfirm")}
                        </button>
                        <button className="inline-action" type="button" disabled={pending} onClick={() => setConfirmArchive(null)}>
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : (
                      <button className="inline-action danger" type="button" disabled={pending} onClick={() => setConfirmArchive(material.id)}>
                        {t("materials.archive")}
                      </button>
                    )}
                  </td>
                )}
              </tr>

              {editing?.id === material.id && (
                <tr className="material-editor-row">
                  <td colSpan={columnCount}>
                    <form className="inline-form" onSubmit={saveMaterial}>
                      <label>
                        {t("materials.name")}
                        <input required maxLength={200} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
                      </label>
                      <UnitField t={t} value={editing.unit} onChange={(unit) => setEditing({ ...editing, unit })} />
                      <button className="primary-button" type="submit" disabled={pending || !editing.name.trim()}>
                        {pending ? t("common.saving") : t("common.save")}
                      </button>
                      <button className="secondary-button" type="button" disabled={pending} onClick={() => setEditing(null)}>
                        {t("common.cancel")}
                      </button>
                    </form>
                  </td>
                </tr>
              )}

              {pricing?.materialId === material.id && (
                <tr className="material-editor-row">
                  <td colSpan={columnCount}>
                    <form className="inline-form" onSubmit={savePrice}>
                      <ModeField value={pricing.mode} onChange={(mode) => setPricing({ ...pricing, mode, divisor: "" })} t={t} />
                      <PriceFields mode={pricing.mode} t={t} price={pricing.price} divisor={pricing.divisor} onPrice={(price) => setPricing({ ...pricing, price })} onDivisor={(divisor) => setPricing({ ...pricing, divisor })} />
                      <label>
                        {t("materials.currency")}
                        <select value={pricing.currency} onChange={(event) => setPricing({ ...pricing, currency: event.target.value as "MDL" | "EUR" })}>
                          <option value="MDL">MDL</option>
                          <option value="EUR">EUR</option>
                        </select>
                      </label>
                      <button className="primary-button" type="submit" disabled={pending}>
                        {pending ? t("common.saving") : t("materials.savePrice")}
                      </button>
                      <button className="secondary-button" type="button" disabled={pending} onClick={() => setPricing(null)}>
                        {t("common.cancel")}
                      </button>
                    </form>
                    <p className="muted">{t("materials.priceVersionHint")}</p>
                  </td>
                </tr>
              )}

              {purchasing?.materialId === material.id && (
                <tr className="material-editor-row">
                  <td colSpan={columnCount}>
                    <form className="inline-form" onSubmit={savePurchase}>
                      <label>
                        {t("materials.purchaseQuantity")}
                        <input
                          type="number"
                          min="1"
                          step="1"
                          required
                          value={purchasing.quantity}
                          onChange={(event) => setPurchasing({ ...purchasing, quantity: event.target.value })}
                        />
                      </label>
                      <label>
                        {t("materials.packageSize")}
                        <input
                          type="number"
                          min="0.001"
                          step="0.001"
                          required
                          value={purchasing.size}
                          onChange={(event) => setPurchasing({ ...purchasing, size: event.target.value })}
                        />
                      </label>
                      <label>
                        {t("materials.packagePrice")}
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          required
                          value={purchasing.price}
                          onChange={(event) => setPurchasing({ ...purchasing, price: event.target.value })}
                        />
                      </label>
                      <label>
                        {t("materials.purchaseDate")}
                        <input
                          type="date"
                          value={purchasing.purchasedAt}
                          onChange={(event) => setPurchasing({ ...purchasing, purchasedAt: event.target.value })}
                        />
                      </label>
                      <label>
                        {t("materials.supplier")}
                        <input
                          maxLength={200}
                          value={purchasing.supplier}
                          onChange={(event) => setPurchasing({ ...purchasing, supplier: event.target.value })}
                        />
                      </label>
                      <button className="primary-button" type="submit" disabled={pending}>
                        {pending ? t("common.saving") : t("materials.savePurchase")}
                      </button>
                      <button className="secondary-button" type="button" disabled={pending} onClick={() => setPurchasing(null)}>
                        {t("common.cancel")}
                      </button>
                    </form>
                    <p className="muted">{t("materials.purchaseHint")}</p>
                  </td>
                </tr>
              )}

              {checking?.materialId === material.id && (
                <tr className="material-editor-row">
                  <td colSpan={columnCount}>
                    <form className="inline-form" onSubmit={saveStockCheck}>
                      {/* The established shape for a mutually exclusive choice:
                          one option per line, as the commission and visit forms
                          already render theirs. No new styles for this screen. */}
                      <fieldset className="checkbox-set costing-view">
                        <legend>{t("materials.stockCheckQuestion")}</legend>
                        {hasPackage(material) ? (
                          STOCK_BUCKETS.map((bucket) => (
                            <label className="checkbox-field" key={bucket.key}>
                              <input
                                type="radio"
                                name={`stock-${material.id}`}
                                checked={checking.share === bucket.share}
                                onChange={() => setChecking({ ...checking, share: bucket.share })}
                              />
                              {t(bucket.key)}
                            </label>
                          ))
                        ) : (
                          // No packaging on file, so there is no bottle to be a
                          // quarter of. The honest fallback is the quantity itself.
                          <label>
                            {t("materials.quantity")}
                            <input
                              type="number"
                              min="0"
                              step="0.001"
                              required
                              value={checking.exact}
                              onChange={(event) => setChecking({ ...checking, exact: event.target.value })}
                            />
                          </label>
                        )}
                      </fieldset>
                      {(() => {
                        const expected = expectedStockLabel(
                          stockByMaterial.get(material.id),
                          material,
                          tag,
                          t,
                        );
                        return expected === null ? null : (
                          <p className="muted">
                            {t("materials.stockCheckExpected", { amount: expected })}
                          </p>
                        );
                      })()}
                      <button
                        className="primary-button"
                        type="submit"
                        disabled={pending || (hasPackage(material) && checking.share === null)}
                      >
                        {pending ? t("common.saving") : t("materials.stockCheckSave")}
                      </button>
                      <button className="secondary-button" type="button" disabled={pending} onClick={() => setChecking(null)}>
                        {t("common.cancel")}
                      </button>
                    </form>
                    <p className="muted">{t("materials.stockCheckHint")}</p>
                  </td>
                </tr>
              )}

              {renderCalibration(stockByMaterial.get(material.id), material, tag, t, columnCount)}

              {material.price_history.length > 0 && (
                <tr className="material-history-row">
                  <td colSpan={columnCount}>
                    <details>
                      <summary>{t("materials.priceHistory")} ({material.price_history.length})</summary>
                      <ul className="compact-list material-price-history">
                        {material.price_history.map((version) => (
                          <li key={version.id}>
                            <time dateTime={version.valid_from}>
                              {new Intl.DateTimeFormat(tag, { dateStyle: "medium" }).format(new Date(version.valid_from))}
                            </time>
                            {" — "}{describePrice(version, material.base_unit, tag, t)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

function UnitField({
  t,
  value,
  onChange,
  disabled = false,
}: {
  t: ReturnType<typeof getTranslator>;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label>
      {t("materials.unit")}
      <select
        name="base_unit"
        defaultValue={onChange ? undefined : "ml"}
        value={onChange ? value : undefined}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        disabled={disabled}
      >
        <option value="ml">{t("unit.ml")}</option>
        <option value="g">{t("unit.g")}</option>
        <option value="piece">{t("unit.piece")}</option>
      </select>
    </label>
  );
}

function ModeField({ value, onChange, t }: { value: MaterialCostingMode; onChange: (mode: MaterialCostingMode) => void; t: ReturnType<typeof getTranslator> }) {
  return (
    <label>
      {t("materials.costingMode")}
      <select value={value} onChange={(event) => onChange(event.target.value as MaterialCostingMode)}>
        {modes.map((mode) => <option key={mode} value={mode}>{t(modeKey(mode))}</option>)}
      </select>
    </label>
  );
}

function PriceFields({
  mode,
  t,
  price,
  divisor,
  onPrice,
  onDivisor,
}: {
  mode: MaterialCostingMode;
  t: ReturnType<typeof getTranslator>;
  price?: string;
  divisor?: string;
  onPrice?: (value: string) => void;
  onDivisor?: (value: string) => void;
}) {
  const controlled = onPrice !== undefined;
  return (
    <>
      <label>
        {mode === "fixed_per_service" ? t("materials.fixedCost") : t("materials.packagePrice")}
        <input name="price" type="number" min="0" step="0.01" value={controlled ? price : undefined} onChange={controlled ? (event) => onPrice(event.target.value) : undefined} />
      </label>
      {mode !== "fixed_per_service" && (
        <label>
          {mode === "quantity" ? t("materials.packageSize") : t("materials.servicesPerPackage")}
          <input name="divisor" type="number" min="0.001" step="0.001" value={onDivisor ? divisor : undefined} onChange={onDivisor ? (event) => onDivisor(event.target.value) : undefined} />
        </label>
      )}
    </>
  );
}

function buildPricePayload(mode: MaterialCostingMode, price: string, divisor: string, required = false): Record<string, number> | null {
  if (!price && !divisor && !required) return {};
  const amountMinor = Math.round(Number(price) * 100);
  if (!price || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return null;
  if (mode === "fixed_per_service") return { fixed_cost_minor: amountMinor };
  const quantity = Number(divisor);
  if (!divisor || !Number.isFinite(quantity) || quantity <= 0) return null;
  return mode === "quantity"
    ? { package_price_minor: amountMinor, package_size: quantity }
    : { package_price_minor: amountMinor, services_per_package: quantity };
}

function modeKey(mode: MaterialCostingMode): MessageKey {
  return mode === "quantity"
    ? "materials.mode.quantity"
    : mode === "services_per_package"
      ? "materials.mode.servicesPerPackage"
      : "materials.mode.fixedPerService";
}

function renderCurrentPrice(material: MaterialRow, locale: string, t: ReturnType<typeof getTranslator>) {
  if (!material.current_price) return <span className="badge-warning">{t("materials.priceMissing")}</span>;
  return describePrice(material.current_price, material.base_unit, locale, t);
}

function describePrice(
  price: Pick<NonNullable<MaterialRow["current_price"]>, "package_price_minor" | "package_size_milli_units" | "costing_mode" | "currency">,
  unit: string,
  locale: string,
  t: ReturnType<typeof getTranslator>,
) {
  const money = formatMoneyMinor(price.package_price_minor, price.currency, locale);
  if (price.costing_mode === "fixed_per_service") return `${money} / ${t("materials.service")}`;
  const divisor = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(price.package_size_milli_units / 1000);
  if (price.costing_mode === "services_per_package") {
    const perService = Math.round(price.package_price_minor * 1000 / price.package_size_milli_units);
    return `${money} / ${divisor} ${t("materials.servicesShort")} (${formatMoneyMinor(perService, price.currency, locale)} / ${t("materials.service")})`;
  }
  const perUnit = Math.round(price.package_price_minor * 1000 / price.package_size_milli_units);
  return `${money} / ${divisor} ${t(`unit.${unit}` as MessageKey)} (${formatMoneyMinor(perUnit, price.currency, locale)} / ${t(`unit.${unit}` as MessageKey)})`;
}

/** True when the material is priced by a package the buckets can be a share of. */
function hasPackage(material: MaterialRow): boolean {
  return material.current_price?.costing_mode === "quantity";
}

function formatQuantity(milliUnits: number, unit: string, locale: string, t: Translate) {
  const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    fromMilliUnits(milliUnits),
  );
  return `${amount} ${t(`unit.${unit}` as MessageKey)}`;
}

/**
 * The balance in words. Procedures first and the raw quantity second, section
 * 36: "≈18 процедур" is the decision, "6.84 ml" is homework.
 */
function describeStock(row: MaterialStockRow, t: Translate): string {
  if (row.status === "out") return t("materials.stockOut");
  if (row.remaining_services !== null) {
    return t("materials.stockRemaining", { count: row.remaining_services });
  }
  /*
   * There is stock but no visit has ever used this material, so there is no
   * usage figure to turn it into procedures. "In stock" is the honest answer;
   * saying it needs attention would raise an alarm about a full bottle.
   */
  return t("materials.stockOnHand");
}

function renderStock(
  row: MaterialStockRow | undefined,
  material: MaterialRow,
  locale: string,
  t: Translate,
) {
  // Absent or unknown are the same answer on screen, and it is not "0".
  if (!row || row.balance_milli_units === null) {
    return <span className="muted">{t("materials.stockUnknown")}</span>;
  }

  const quantity = formatQuantity(
    Math.max(0, row.balance_milli_units),
    material.base_unit,
    locale,
    t,
  );

  return (
    <>
      <strong className={row.status === "ok" ? undefined : "badge-warning"}>
        {describeStock(row, t)}
      </strong>
      <span className="unit-hint">{quantity}</span>
      <span className="unit-hint">
        {row.basis === "check" && row.baseline_at
          ? t("materials.stockBasisCheck", {
              date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                new Date(row.baseline_at),
              ),
            })
          : t("materials.stockBasisPurchases")}
      </span>
    </>
  );
}

/** What the estimate predicts right now, shown beside the count being entered. */
function expectedStockLabel(
  row: MaterialStockRow | undefined,
  material: MaterialRow,
  locale: string,
  t: Translate,
): string | null {
  if (!row || row.balance_milli_units === null) return null;
  return formatQuantity(Math.max(0, row.balance_milli_units), material.base_unit, locale, t);
}

/**
 * The calibration hint, section 39.
 *
 * Shown, never applied. A norm is what the owner said their work costs, and one
 * eyeballed bottle is not grounds for rewriting it behind their back — so this
 * says which way the estimate is off and leaves the recipe alone.
 */
function renderCalibration(
  row: MaterialStockRow | undefined,
  material: MaterialRow,
  locale: string,
  t: Translate,
  columnCount: number,
) {
  if (!row?.calibration?.significant) return null;

  const expected = formatQuantity(row.calibration.expectedMilliUnits, material.base_unit, locale, t);
  const observed = formatQuantity(row.calibration.observedMilliUnits, material.base_unit, locale, t);

  return (
    <tr className="material-history-row">
      <td colSpan={columnCount}>
        <p className="muted">
          {t(
            row.calibration.driftMilliUnits < 0
              ? "materials.calibrationFaster"
              : "materials.calibrationSlower",
            { expected, observed },
          )}
        </p>
      </td>
    </tr>
  );
}

async function responseError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  return payload?.error?.message ?? fallback;
}
