import { Logger } from "@medusajs/framework/types"
import {
  hasCustomFieldSchemas,
  listCustomFieldSchemaEntities,
} from "@medusajs/framework/utils"

/**
 * Register the generated custom entity CRUD workflows for every configured
 * entity, at boot.
 *
 * Registration is a side effect of calling a factory
 * (`createCustomEntityWorkflow("supplier")`), so without this each workflow
 * would exist only after user code happened to call it in the current process
 * — a durable engine could not resume a persisted execution after a restart,
 * and nothing could list the workflows. Touching the factories here means
 * every boot (including every dev-mode restart) registers the workflows for
 * the configuration it booted with.
 */
export default async function registerCustomEntityWorkflows(
  logger: Logger
): Promise<void> {
  if (!hasCustomFieldSchemas()) {
    return
  }

  const {
    createCustomEntityWorkflow,
    deleteCustomEntityWorkflow,
    resolveCustomEntityOwner,
    restoreCustomEntityWorkflow,
    softDeleteCustomEntityWorkflow,
    updateCustomEntityWorkflow,
  } = await import("@medusajs/core-flows")

  for (const entity of listCustomFieldSchemaEntities()) {
    try {
      resolveCustomEntityOwner(entity)
    } catch {
      // A core entity (its dedicated workflows carry the custom fields steps)
      // or an entity whose module is not installed. Neither registers generic
      // workflows; the router's reconciliation warning surfaces visible gaps.
      logger.debug(
        `Custom fields: no generated workflows for "${entity}" (core entity or unowned)`
      )
      continue
    }

    createCustomEntityWorkflow(entity)
    updateCustomEntityWorkflow(entity)
    deleteCustomEntityWorkflow(entity)
    softDeleteCustomEntityWorkflow(entity)
    restoreCustomEntityWorkflow(entity)
  }
}
