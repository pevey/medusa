import {
  WorkflowData,
  WorkflowResponse,
  createWorkflow,
  parallelize,
  transform,
} from "@medusajs/framework/workflows-sdk"
import {
  deleteCustomFieldsStep,
  restoreCustomFieldsStep,
  softDeleteCustomFieldsStep,
  upsertCustomFieldsStep,
  validateCustomFieldsStep,
} from "../../common"
import {
  createCustomEntityStep,
  deleteCustomEntityStep,
  restoreCustomEntityStep,
  softDeleteCustomEntityStep,
  updateCustomEntityStep,
  validateCustomEntityStep,
} from "../steps/custom-entity-crud"

/**
 * Generated CRUD workflows for entities from a project's own modules.
 *
 * A module built on `MedusaService` gets `createSuppliers` / `softDeleteSuppliers` /
 * `restoreSuppliers` for free but no workflows — and custom field values live in
 * the custom fields module, outside the entity's own transaction, so writing
 * them correctly needs orchestration: validate before the write, persist after
 * it, compensate on failure. These factories generate that orchestration per
 * entity, so the contract is the same one core entities already follow:
 * **writes go through workflows; direct service calls bypass custom fields.**
 *
 * Each factory is memoized per entity and returns an ordinary workflow:
 *
 * @example
 * const { result } = await createCustomEntityWorkflow("supplier")(req.scope).run({
 *   input: { records: [{ name: "Acme", custom_fields: { country_of_origin: "US" } }] },
 * })
 *
 * Naming mirrors the generated *service* methods, not core workflow names —
 * so `deleteCustomEntityWorkflow` is a **hard** delete like `deleteSuppliers`,
 * while core's `deleteProductsWorkflow` soft-deletes. The soft path is
 * `softDeleteCustomEntityWorkflow`; `restoreCustomEntityWorkflow` undoes it.
 *
 * Core entities are refused at run time: their dedicated workflows carry
 * logic (links, inventory, sales channels) these generic ones cannot know.
 */

export type CreateCustomEntityWorkflowInput = {
  /**
   * The records to create, each carrying the entity's own fields plus an
   * optional `custom_fields` object — the same shape reads return.
   */
  records: Record<string, unknown>[]
}

export type UpdateCustomEntityWorkflowInput = {
  /**
   * The records to update. `custom_fields` is partial: an absent key is left
   * alone, an explicit null clears the value.
   */
  records: ({ id: string } & Record<string, unknown>)[]
}

export type CustomEntityIdsWorkflowInput = {
  ids: string[]
}

function splitCustomFields(records: Record<string, unknown>[]) {
  return {
    records: records.map((record) => ({ ...record, custom_fields: undefined })),
    customFieldValues: records.map(
      (record) => (record.custom_fields ?? {}) as Record<string, unknown>
    ),
  }
}

const createCache = new Map<string, ReturnType<typeof buildCreateWorkflow>>()

function buildCreateWorkflow(entity: string) {
  return createWorkflow(
    `create-custom-entity-${entity}`,
    (input: WorkflowData<CreateCustomEntityWorkflowInput>) => {
      // First, so a core or unknown entity is refused before any other step
      // acts — see the step's doc comment.
      validateCustomEntityStep({ entity })

      const split = transform({ input }, (data) =>
        splitCustomFields(data.input.records)
      )

      // Ahead of the write, so a missing required custom field rejects the
      // request rather than creating a record and rolling it back.
      validateCustomFieldsStep({ entity, values: split.customFieldValues })

      const created = createCustomEntityStep({
        entity,
        records: split.records,
      })

      const customFieldRecords = transform({ created, split }, (data) =>
        data.created.map((record: any, i: number) => ({
          id: record.id,
          values: data.split.customFieldValues[i] ?? {},
        }))
      )

      upsertCustomFieldsStep({ entity, records: customFieldRecords })

      return new WorkflowResponse(created)
    }
  )
}

/**
 * Create records of a custom entity, custom fields included. The counterpart
 * of the generated `create<Model>` — hard-deletes the created records on
 * compensation.
 */
export function createCustomEntityWorkflow(entity: string) {
  if (!createCache.has(entity)) {
    createCache.set(entity, buildCreateWorkflow(entity))
  }

  return createCache.get(entity)!
}

const updateCache = new Map<string, ReturnType<typeof buildUpdateWorkflow>>()

function buildUpdateWorkflow(entity: string) {
  return createWorkflow(
    `update-custom-entity-${entity}`,
    (input: WorkflowData<UpdateCustomEntityWorkflowInput>) => {
      validateCustomEntityStep({ entity })

      const split = transform({ input }, (data) =>
        splitCustomFields(data.input.records)
      )

      validateCustomFieldsStep({
        entity,
        values: split.customFieldValues,
        partial: true,
      })

      const updated = updateCustomEntityStep({
        entity,
        records: split.records as any,
      })

      const customFieldRecords = transform({ input }, (data) =>
        data.input.records
          .map((record) => ({
            id: record.id,
            values: ((record as Record<string, unknown>).custom_fields ??
              {}) as Record<string, unknown>,
          }))
          .filter((record) => Object.keys(record.values).length)
      )

      upsertCustomFieldsStep({
        entity,
        records: customFieldRecords,
        partial: true,
      })

      return new WorkflowResponse(updated)
    }
  )
}

/**
 * Update records of a custom entity, custom fields included. Partial on both
 * halves; compensation writes the previous field values back.
 */
export function updateCustomEntityWorkflow(entity: string) {
  if (!updateCache.has(entity)) {
    updateCache.set(entity, buildUpdateWorkflow(entity))
  }

  return updateCache.get(entity)!
}

const deleteCache = new Map<string, ReturnType<typeof buildDeleteWorkflow>>()

function buildDeleteWorkflow(entity: string) {
  return createWorkflow(
    `delete-custom-entity-${entity}`,
    (input: WorkflowData<CustomEntityIdsWorkflowInput>) => {
      validateCustomEntityStep({ entity })

      // The satellite rows are snapshotted and re-inserted on compensation;
      // the entity rows themselves have no undo — `delete<Model>` semantics.
      parallelize(
        deleteCustomEntityStep({ entity, ids: input.ids }),
        deleteCustomFieldsStep({ entity, ids: input.ids })
      )

      return new WorkflowResponse(void 0)
    }
  )
}

/**
 * **Hard**-delete records of a custom entity and their custom field rows —
 * `delete<Model>` semantics, unlike core's `deleteProductsWorkflow`, which
 * soft-deletes. For the undoable path use
 * {@link softDeleteCustomEntityWorkflow}.
 */
export function deleteCustomEntityWorkflow(entity: string) {
  if (!deleteCache.has(entity)) {
    deleteCache.set(entity, buildDeleteWorkflow(entity))
  }

  return deleteCache.get(entity)!
}

const softDeleteCache = new Map<
  string,
  ReturnType<typeof buildSoftDeleteWorkflow>
>()

function buildSoftDeleteWorkflow(entity: string) {
  return createWorkflow(
    `soft-delete-custom-entity-${entity}`,
    (input: WorkflowData<CustomEntityIdsWorkflowInput>) => {
      validateCustomEntityStep({ entity })

      // Satellite rows follow the owner, exactly as link rows do in core's
      // delete workflows; both halves restore on compensation.
      parallelize(
        softDeleteCustomEntityStep({ entity, ids: input.ids }),
        softDeleteCustomFieldsStep({ entity, ids: input.ids })
      )

      return new WorkflowResponse(void 0)
    }
  )
}

/**
 * Soft-delete records of a custom entity, their custom field rows following in
 * tandem. Undone by {@link restoreCustomEntityWorkflow}.
 */
export function softDeleteCustomEntityWorkflow(entity: string) {
  if (!softDeleteCache.has(entity)) {
    softDeleteCache.set(entity, buildSoftDeleteWorkflow(entity))
  }

  return softDeleteCache.get(entity)!
}

const restoreCache = new Map<string, ReturnType<typeof buildRestoreWorkflow>>()

function buildRestoreWorkflow(entity: string) {
  return createWorkflow(
    `restore-custom-entity-${entity}`,
    (input: WorkflowData<CustomEntityIdsWorkflowInput>) => {
      validateCustomEntityStep({ entity })

      parallelize(
        restoreCustomEntityStep({ entity, ids: input.ids }),
        restoreCustomFieldsStep({ entity, ids: input.ids })
      )

      return new WorkflowResponse(void 0)
    }
  )
}

/**
 * Restore soft-deleted records of a custom entity, their custom field rows
 * with them — `restore<Model>` semantics.
 */
export function restoreCustomEntityWorkflow(entity: string) {
  if (!restoreCache.has(entity)) {
    restoreCache.set(entity, buildRestoreWorkflow(entity))
  }

  return restoreCache.get(entity)!
}
