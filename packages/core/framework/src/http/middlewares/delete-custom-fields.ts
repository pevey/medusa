import { MedusaError, Modules, getCustomFieldSchema } from "@medusajs/utils"

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "../types"

/**
 * Carry an entity's custom field rows along when a route deletes, soft-deletes,
 * or restores the entity directly through its module service, without a
 * workflow.
 *
 * Core entities do not use these: their delete workflows carry
 * `softDeleteCustomFieldsStep` and friends, which also cover callers that
 * never touch HTTP. These middlewares are the opt-in for `MedusaService`-CRUD
 * routes, the same way `persistCustomFields` is for create and update.
 *
 * There are three, one per generated service method, because no middleware can
 * see which method a handler calls — but the route author can: they wrote the
 * handler. The middleware name states the semantics on the route itself:
 *
 * @example
 * {
 *   method: ["DELETE"],
 *   matcher: "/admin/brands/:id",
 *   entity: "brand",
 *   middlewares: [softDeleteCustomFields()],   // handler calls softDeleteBrands
 * }
 * {
 *   method: ["POST"],
 *   matcher: "/admin/brands/:id/restore",
 *   entity: "brand",
 *   middlewares: [restoreCustomFields()],      // handler calls restoreBrands
 * }
 *
 * The subject is the last route parameter in the matcher — these middlewares
 * never create records, so an action-style matcher ending in a literal
 * (`/:id/restore`) still has an unambiguous target. A matcher with no params
 * is refused rather than guessed at.
 *
 * The satellite write runs inside the wrapped `res.json`, only on a success
 * response — a handler failure leaves the rows untouched, and a satellite
 * failure is still reportable because nothing has been flushed. Like
 * `persistCustomFields`, what these cannot offer is compensation.
 */
function customFieldsDeletion(
  middlewareName: string,
  serviceMethod: "deleteValues" | "softDeleteValues" | "restoreValues"
) {
  const middleware = function (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) {
    const entity = req.customFieldsEntity

    // No entity declared, or no custom fields configured for it.
    if (!entity || !getCustomFieldSchema(entity, "update")) {
      return next()
    }

    const param = req.customFieldsLastParam
    const ownerId = param ? req.params?.[param] : undefined

    if (!ownerId) {
      return next(
        new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `${middlewareName}() requires the route matcher to carry the ` +
            `"${entity}" record's id as a route parameter`
        )
      )
    }

    const respond = res.json.bind(res)

    res.json = function (payload: any) {
      // Restored first so the wrapper is single-fire — the error handler also
      // responds through `res.json`.
      res.json = respond

      // The handler failed; the rows stay as they are.
      if (res.statusCode >= 400) {
        return respond(payload)
      }

      const write = async () => {
        const service = req.scope.resolve<any>(Modules.CUSTOM_FIELDS)
        await service[serviceMethod](entity, [ownerId])
      }

      write().then(
        () => respond(payload),
        (e) => next(e)
      )

      return res
    } as typeof res.json

    return next()
  }

  Object.defineProperty(middleware, "name", { value: middlewareName })

  return middleware
}

/**
 * For a route whose handler calls the generated `delete<Model>` — a hard
 * delete. The satellite rows are hard-deleted with it.
 */
export function deleteCustomFields() {
  return customFieldsDeletion("deleteCustomFields", "deleteValues")
}

/**
 * For a route whose handler calls the generated `softDelete<Model>`. The
 * satellite rows are soft-deleted in tandem and come back on restore.
 */
export function softDeleteCustomFields() {
  return customFieldsDeletion("softDeleteCustomFields", "softDeleteValues")
}

/**
 * For a route whose handler calls the generated `restore<Model>`. The
 * satellite rows soft-deleted alongside the owner are restored with it.
 */
export function restoreCustomFields() {
  return customFieldsDeletion("restoreCustomFields", "restoreValues")
}
