import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { resolveCustomFieldsService } from "./resolve-custom-fields-service"

export type ValidateCustomFieldsStepInput = {
  /**
   * The entity the values belong to, matching the `entity` its routes declare —
   * for example `product`.
   */
  entity: string
  /**
   * One entry per record about to be written, holding only the custom field
   * keys the caller stated.
   */
  values: Record<string, unknown>[]
  /**
   * Treat absent keys as untouched rather than omitted. Update workflows pass
   * `true`; create workflows do not.
   */
  partial?: boolean
}

export const validateCustomFieldsStepId = "validate-custom-fields"

/**
 * Reject invalid custom field values before anything is written.
 *
 * Placed ahead of the step that creates or updates the entity itself, so a
 * missing required field fails the workflow while it is still a no-op. Doing
 * the check on the way in — rather than letting the write proceed and relying
 * on `upsertCustomFieldsStep` to throw afterwards — is the difference between a
 * clean rejection and a compensated rollback of a row that should never have
 * existed.
 *
 * Writes nothing, so there is nothing to compensate.
 *
 * A no-op when the module is not installed, so workflows can call it
 * unconditionally.
 */
export const validateCustomFieldsStep = createStep(
  validateCustomFieldsStepId,
  async (input: ValidateCustomFieldsStepInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!service) {
      return new StepResponse(void 0)
    }

    for (const values of input.values ?? []) {
      // Checked even when a record states no custom fields at all: that is
      // exactly the case where a required one was omitted.
      service.validateValues(input.entity, values ?? {}, {
        partial: input.partial,
      })
    }

    return new StepResponse(void 0)
  }
)

export type UpsertCustomFieldsStepInput = {
  /**
   * The entity the values belong to, matching the `entity` its routes declare —
   * for example `product`.
   */
  entity: string
  /**
   * One entry per record. `values` holds only the custom field keys.
   */
  records: { id: string; values: Record<string, unknown> }[]
  /**
   * Leave unlisted keys untouched instead of treating them as omitted. Update
   * workflows pass `true`; create workflows do not.
   */
  partial?: boolean
}

export const upsertCustomFieldsStepId = "upsert-custom-fields"

/**
 * Persist custom field values for one or more records of an entity.
 *
 * One shared step rather than bespoke logic per workflow: the values are always
 * written through the custom fields module, which validates them against the
 * configured definitions. That is what makes custom field rules hold for every
 * caller — a workflow invoked from a subscriber or a seed script is held to the
 * same rules as an API request.
 *
 * Runs after the entity exists, since it needs an id. Pair it with
 * `validateCustomFieldsStep` ahead of the create or update so a rejection
 * happens before the write rather than as a rollback after it.
 *
 * A no-op when the module is not installed, so workflows can call it
 * unconditionally.
 *
 * @example
 * upsertCustomFieldsStep({
 *   entity: "product",
 *   records: [{ id: "prod_123", values: { brand: "Acme" } }],
 * })
 */
export const upsertCustomFieldsStep = createStep(
  upsertCustomFieldsStepId,
  async (input: UpsertCustomFieldsStepInput, { container }) => {
    // Only records that actually carry values are written. An owner that stated
    // nothing keeps no satellite row at all — the absence the nullable columns
    // are designed around. Enforcement of `required` belongs to
    // `validateCustomFieldsStep`, which runs before any of this.
    const records = (input.records ?? []).filter(
      (record) => record.id && Object.keys(record.values ?? {}).length
    )

    const service = resolveCustomFieldsService(container)

    if (!records.length || !service) {
      return new StepResponse(void 0, null)
    }

    // Capture the rows as they stand — including whether they existed at all —
    // so compensation can put back exactly that state. Rows this write creates
    // are deleted on compensation; rows that predated it are restored.
    const snapshot = await service.snapshotValues(
      input.entity,
      records.map((record) => record.id)
    )

    for (const record of records) {
      await service.setValues(input.entity, record.id, record.values, {
        partial: input.partial,
      })
    }

    return new StepResponse(void 0, { entity: input.entity, snapshot })
  },
  async (compensateInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!compensateInput || !service) {
      return
    }

    // Not `setValues`: restoring prior state is not a user write, and
    // re-validating it could fail the compensation itself — see
    // `restoreSnapshot`.
    await service.restoreSnapshot(
      compensateInput.entity,
      compensateInput.snapshot
    )
  }
)

