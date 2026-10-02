import { z } from "zod";

import { MAX_SERVICES } from "@/domain/service-limit";
import type { VisitServiceItem } from "@/lib/visit-service";

/**
 * Which services a visit or an appointment is made of, as the API takes it.
 *
 * `services` is a list of objects rather than a list of ids, because an add-on
 * belongs to the service it was chosen for: «дизайн» on a manicure and on a
 * pedicure are two lines under two rules, and a flat `add_on_ids` beside a flat
 * `service_ids` would leave the pairing to a guess. The single `service_id`
 * with its `add_on_ids` every client already sends is taken as a list of one.
 */

const serviceItem = z.object({
  service_id: z.uuid(),
  add_on_ids: z.array(z.uuid()).max(20).default([]),
});

export const serviceSelection = {
  service_id: z.uuid().optional(),
  services: z.array(serviceItem).min(1).max(MAX_SERVICES).optional(),
};

type Selection = Readonly<{
  service_id?: string;
  add_on_ids: readonly string[];
  services?: readonly Readonly<{ service_id: string; add_on_ids: readonly string[] }>[];
}>;

/**
 * Exactly one of the two forms, and no service twice.
 *
 * Twice is refused rather than merged: the same service twice in one sitting is
 * not something a studio sells, and two lines of it would pay the master's
 * fixed amount once and the price twice without anyone having decided that.
 */
export function refineServiceSelection(value: Selection, context: z.RefinementCtx) {
  if ((value.services === undefined) === (value.service_id === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["services"],
      message: "Send either services or service_id",
    });
    return;
  }
  if (value.services && value.add_on_ids.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["add_on_ids"],
      message: "With services, add-ons go inside each service",
    });
  }
  const ids = (value.services ?? []).map((item) => item.service_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["services"], message: "A service appears twice" });
  }
}

export function serviceItemsOf(value: Selection): VisitServiceItem[] {
  return value.services
    ? value.services.map((item) => ({ serviceId: item.service_id, addOnIds: [...item.add_on_ids] }))
    : [{ serviceId: value.service_id!, addOnIds: [...value.add_on_ids] }];
}
