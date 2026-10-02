import { describe, expect, it } from "vitest";

import {
  addOnsFor,
  nextServiceId,
  selectionTotals,
  toServicesPayload,
  type PickerAddOn,
  type PickerService,
} from "@/components/service-lines-field";

const services: PickerService[] = [
  { id: "manicure", name: "Маникюр", priceMinor: 60_000, durationMinutes: 90 },
  { id: "pedicure", name: "Педикюр", priceMinor: 40_000, durationMinutes: 60 },
];
const addOns: PickerAddOn[] = [
  { id: "design", name: "Дизайн", priceDeltaMinor: 10_000, durationDeltaMinutes: 15, serviceIds: ["manicure"] },
  { id: "short", name: "Короткие", priceDeltaMinor: -70_000, durationDeltaMinutes: -10, serviceIds: ["manicure"] },
  { id: "any", name: "Снятие", priceDeltaMinor: 5_000, durationDeltaMinutes: 10, serviceIds: null },
];

describe("addOnsFor", () => {
  it("offers an add-on with its own services, and an unlinked one with any", () => {
    expect(addOnsFor("manicure", addOns).map((addOn) => addOn.id)).toEqual(["design", "short", "any"]);
    expect(addOnsFor("pedicure", addOns).map((addOn) => addOn.id)).toEqual(["any"]);
  });
});

describe("selectionTotals", () => {
  it("adds up every service with its own add-ons", () => {
    expect(
      selectionTotals(
        [
          { serviceId: "manicure", addOnIds: ["design"] },
          { serviceId: "pedicure", addOnIds: ["any"] },
        ],
        services,
        addOns,
      ),
    ).toEqual({ priceMinor: 70_000 + 45_000, durationMinutes: 105 + 70 });
  });

  it("floors each service at free, so a reduction cannot pay for the next one", () => {
    expect(
      selectionTotals(
        [
          { serviceId: "manicure", addOnIds: ["short"] },
          { serviceId: "pedicure", addOnIds: [] },
        ],
        services,
        addOns,
      ).priceMinor,
    ).toBe(40_000);
  });

  it("ignores an add-on not offered with the service, and a service not in the list", () => {
    expect(
      selectionTotals(
        [
          { serviceId: "pedicure", addOnIds: ["design"] },
          { serviceId: "gone", addOnIds: [] },
        ],
        services,
        addOns,
      ),
    ).toEqual({ priceMinor: 40_000, durationMinutes: 60 });
  });

  it("reads a service the screen quotes no price for as free", () => {
    expect(
      selectionTotals([{ serviceId: "x", addOnIds: [] }], [{ id: "x", name: "X", durationMinutes: null }], []),
    ).toEqual({ priceMinor: 0, durationMinutes: 0 });
  });
});

describe("nextServiceId", () => {
  it("offers the first service not yet in the sitting, and nothing once all are", () => {
    expect(nextServiceId([{ serviceId: "manicure", addOnIds: [] }], services)).toBe("pedicure");
    expect(
      nextServiceId(
        [
          { serviceId: "manicure", addOnIds: [] },
          { serviceId: "pedicure", addOnIds: [] },
        ],
        services,
      ),
    ).toBeNull();
  });
});

describe("toServicesPayload", () => {
  it("is the body both endpoints take", () => {
    expect(toServicesPayload([{ serviceId: "manicure", addOnIds: ["design"] }])).toEqual([
      { service_id: "manicure", add_on_ids: ["design"] },
    ]);
  });
});
