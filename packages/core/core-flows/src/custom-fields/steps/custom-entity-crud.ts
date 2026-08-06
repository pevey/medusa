import { MedusaModule } from "@medusajs/framework/modules-sdk"
import {
  MedusaError,
  Modules,
  pluralize,
  upperCaseFirst,
} from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

/**
 * The service names of core modules. The `*CustomEntityWorkflow` factories are
 * for entities from a project's own modules — a core entity already has a
 * dedicated workflow carrying logic these generic ones know nothing about
 * (sales channels, inventory, links), and running the generic one against it
 * would bypass that logic and double-persist custom fields.
 */
const CORE_SERVICE_NAMES = new Set<string>(Object.values(Modules))

/**
 * Find the module that owns an entity, the way the custom fields module's
 * link registration does: by alias in the joiner configs. Runs at step time,
 * long after boot, so every module's config is available.
 */
export function resolveCustomEntityOwner(entity: string): {
  serviceName: string
  /**
   * The suffix of the generated `MedusaService` methods — `Suppliers` for the
   * `Supplier` model, giving `createSuppliers`, `softDeleteSuppliers`, and so on.
   */
  methodSuffix: string
} {
  for (const config of MedusaModule.getAllJoinerConfigs()) {
    if (config.isLink) {
      continue
    }

    const aliases = Array.isArray(config.alias)
      ? config.alias
      : config.alias
      ? [config.alias]
      : []

    for (const alias of aliases) {
      const names = Array.isArray(alias.name) ? alias.name : [alias.name]

      if (!names.includes(entity) || !alias.entity) {
        continue
      }

      if (CORE_SERVICE_NAMES.has(config.serviceName!)) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `"${entity}" belongs to the core "${config.serviceName}" module. ` +
            `Use its dedicated workflows — for example ` +
            `${config.serviceName === Modules.PRODUCT ? "createProductsWorkflow" : "its create/update/delete workflows"} — ` +
            `which carry logic the generic custom entity workflows do not.`
        )
      }

      return {
        serviceName: config.serviceName!,
        // The joiner config publishes the authoritative suffix — it honors a
        // module's `plural`/`singular` overrides, which a re-derived
        // pluralization would not. The derivation is only the fallback for a
        // config that does not carry it.
        methodSuffix:
          ((alias as any).args?.methodSuffix as string | undefined) ??
          pluralize(upperCaseFirst(alias.entity)),
      }
    }
  }

  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `No module exposes an entity named "${entity}" to the query graph`
  )
}

/**
 * Resolve the owning module's service and the generated method for one verb,
 * guarding that the method actually exists — a module with a hand-written
 * service gets an actionable error naming the remedy, not a bare TypeError.
 */
export function resolveCustomEntityService(
  container: { resolve: (key: string) => any },
  entity: string,
  verb: "create" | "update" | "delete" | "softDelete" | "restore" | "list"
): { service: any; method: string } {
  const { serviceName, methodSuffix } = resolveCustomEntityOwner(entity)
  const service = container.resolve(serviceName)
  const method = `${verb}${methodSuffix}`

  if (typeof service?.[method] !== "function") {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `The "${entity}" module's service does not expose "${method}". Extend ` +
        `MedusaService to get the generated CRUD, or give the module dedicated ` +
        `workflows carrying the custom fields steps.`
    )
  }

  return { service, method }
}

/**
 * Resolve — and thereby validate — the entity before anything else runs.
 *
 * The guard has to be its own leading step: field validation would otherwise
 * reject a core entity for the wrong reason before the owner resolution ever
 * ran, and in the delete workflows the entity and custom-fields steps run in
 * `parallelize`, where the satellite step could act before a guard buried in
 * the entity step threw.
 */
export const validateCustomEntityStep = createStep(
  "validate-custom-entity",
  async (input: { entity: string }) => {
    resolveCustomEntityOwner(input.entity)
    return new StepResponse(void 0)
  }
)

export const createCustomEntityStep = createStep(
  "create-custom-entity",
  async (
    input: { entity: string; records: Record<string, unknown>[] },
    { container }
  ) => {
    const { service, method } = resolveCustomEntityService(
      container,
      input.entity,
      "create"
    )

    const created = await service[method](input.records)
    const records = Array.isArray(created) ? created : [created]

    return new StepResponse(records, {
      entity: input.entity,
      ids: records.map((record: any) => record.id),
    })
  },
  async (compensateInput, { container }) => {
    if (!compensateInput?.ids?.length) {
      return
    }

    const { service, method } = resolveCustomEntityService(
      container,
      compensateInput.entity,
      "delete"
    )

    // The undo of a create is a hard delete — the rows did not exist before.
    await service[method](compensateInput.ids)
  }
)

export const updateCustomEntityStep = createStep(
  "update-custom-entity",
  async (
    input: {
      entity: string
      records: ({ id: string } & Record<string, unknown>)[]
    },
    { container }
  ) => {
    const { service, method } = resolveCustomEntityService(
      container,
      input.entity,
      "update"
    )
    const { method: listMethod } = resolveCustomEntityService(
      container,
      input.entity,
      "list"
    )

    // Snapshot only the fields being touched, plus the id — the compensation
    // writes exactly these back. Same shape as core's update steps.
    const touched = new Set<string>(["id"])
    for (const record of input.records) {
      Object.keys(record).forEach((key) => touched.add(key))
    }

    const previous = await service[listMethod](
      { id: input.records.map((record) => record.id) },
      { select: [...touched] }
    )

    const updated = await service[method](input.records)

    return new StepResponse(Array.isArray(updated) ? updated : [updated], {
      entity: input.entity,
      previous,
    })
  },
  async (compensateInput, { container }) => {
    if (!compensateInput?.previous?.length) {
      return
    }

    const { service, method } = resolveCustomEntityService(
      container,
      compensateInput.entity,
      "update"
    )

    await service[method](compensateInput.previous)
  }
)

export const deleteCustomEntityStep = createStep(
  "delete-custom-entity",
  async (input: { entity: string; ids: string[] }, { container }) => {
    const { service, method } = resolveCustomEntityService(
      container,
      input.entity,
      "delete"
    )

    // A hard delete has no undo, so this step carries no compensation —
    // matching the semantics of `delete<Model>` itself. Callers who need an
    // undoable delete want the soft-delete workflow.
    await service[method](input.ids)

    return new StepResponse(void 0)
  }
)

export const softDeleteCustomEntityStep = createStep(
  "soft-delete-custom-entity",
  async (input: { entity: string; ids: string[] }, { container }) => {
    const { service, method } = resolveCustomEntityService(
      container,
      input.entity,
      "softDelete"
    )

    await service[method](input.ids)

    return new StepResponse(void 0, { entity: input.entity, ids: input.ids })
  },
  async (compensateInput, { container }) => {
    if (!compensateInput?.ids?.length) {
      return
    }

    const { service, method } = resolveCustomEntityService(
      container,
      compensateInput.entity,
      "restore"
    )

    await service[method](compensateInput.ids)
  }
)

export const restoreCustomEntityStep = createStep(
  "restore-custom-entity",
  async (input: { entity: string; ids: string[] }, { container }) => {
    const { service, method } = resolveCustomEntityService(
      container,
      input.entity,
      "restore"
    )

    await service[method](input.ids)

    return new StepResponse(void 0, { entity: input.entity, ids: input.ids })
  },
  async (compensateInput, { container }) => {
    if (!compensateInput?.ids?.length) {
      return
    }

    const { service, method } = resolveCustomEntityService(
      container,
      compensateInput.entity,
      "softDelete"
    )

    await service[method](compensateInput.ids)
  }
)
