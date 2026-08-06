import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { resolveCustomFieldsService } from "./resolve-custom-fields-service"

/**
 * Custom field values live on a satellite table owned by the custom fields
 * module, so an entity's delete workflows have to carry them along the same
 * way they carry link records: `removeRemoteLinkStep` soft-deletes link rows
 * in tandem with the owner and restores them on compensation, and these steps
 * are its custom-fields counterpart.
 *
 * Which step matches which service method is fixed by Medusa's vocabulary:
 * `delete<Model>` is a hard delete, `softDelete<Model>` sets `deleted_at`,
 * `restore<Model>` clears it. A delete workflow knows which one it performs,
 * so it knows which step to pair with it.
 *
 * All three are no-ops when the custom fields module is not installed, so
 * workflows can call them unconditionally.
 */

export type CustomFieldsDeleteStepInput = {
  /**
   * The entity the rows belong to — for example `product`.
   */
  entity: string
  /**
   * The owners whose satellite rows follow the owner's deletion.
   */
  ids: string[]
}

export const softDeleteCustomFieldsStepId = "soft-delete-custom-fields"

/**
 * Soft-delete the satellite rows of owners being soft-deleted.
 *
 * Compensation restores exactly the rows this step transitioned — an owner
 * whose row was already soft-deleted, or who has no row, is not resurrected
 * by the undo.
 */
export const softDeleteCustomFieldsStep = createStep(
  softDeleteCustomFieldsStepId,
  async (input: CustomFieldsDeleteStepInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!input.ids?.length || !service) {
      return new StepResponse(void 0, null)
    }
    const transitioned = await service.softDeleteValues(input.entity, input.ids)

    return new StepResponse(void 0, {
      entity: input.entity,
      ids: transitioned as string[],
    })
  },
  async (compensateInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!compensateInput?.ids?.length || !service) {
      return
    }
    await service.restoreValues(compensateInput.entity, compensateInput.ids)
  }
)

export const restoreCustomFieldsStepId = "restore-custom-fields"

/**
 * Restore (un-soft-delete) the satellite rows of owners being restored.
 *
 * Compensation re-soft-deletes exactly the rows this step transitioned.
 */
export const restoreCustomFieldsStep = createStep(
  restoreCustomFieldsStepId,
  async (input: CustomFieldsDeleteStepInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!input.ids?.length || !service) {
      return new StepResponse(void 0, null)
    }
    const transitioned = await service.restoreValues(input.entity, input.ids)

    return new StepResponse(void 0, {
      entity: input.entity,
      ids: transitioned as string[],
    })
  },
  async (compensateInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!compensateInput?.ids?.length || !service) {
      return
    }
    await service.softDeleteValues(compensateInput.entity, compensateInput.ids)
  }
)

export const deleteCustomFieldsStepId = "delete-custom-fields"

/**
 * Hard-delete the satellite rows of owners being hard-deleted.
 *
 * A hard delete has no in-place undo, so the rows are snapshotted first and
 * compensation re-inserts them exactly as they were — including a row's
 * soft-deletion state. This is more than link rows get: `removeRemoteLinkStep`
 * has no hard-delete compensation at all.
 */
export const deleteCustomFieldsStep = createStep(
  deleteCustomFieldsStepId,
  async (input: CustomFieldsDeleteStepInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!input.ids?.length || !service) {
      return new StepResponse(void 0, null)
    }

    const snapshot = await service.snapshotValues(input.entity, input.ids)
    await service.deleteValues(input.entity, input.ids)

    return new StepResponse(void 0, { entity: input.entity, snapshot })
  },
  async (compensateInput, { container }) => {
    const service = resolveCustomFieldsService(container)

    if (!compensateInput || !service) {
      return
    }
    await service.restoreSnapshot(compensateInput.entity, compensateInput.snapshot)
  }
)
