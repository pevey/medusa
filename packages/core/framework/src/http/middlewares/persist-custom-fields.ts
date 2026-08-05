import { MedusaError, Modules, pluralize } from "@medusajs/utils"

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "../types"

/**
 * Persist an entity's custom field values for a route that writes them
 * directly, without going through a workflow.
 *
 * Core entities do not use this: their create and update workflows carry
 * `validateCustomFieldsStep` and `upsertCustomFieldsStep`, which also cover
 * callers that never touch HTTP — a subscriber, a seed script, another
 * workflow. Many modules built on `MedusaService` never write a workflow at
 * all, though: the generated `create<Model>` / `update<Model>` methods are
 * called straight from a route. This is the opt-in for those.
 *
 * Add it after the body validator, whose output it reads:
 *
 * @example
 * {
 *   method: ["POST"],
 *   matcher: "/admin/brands",
 *   entity: "brand",
 *   middlewares: [
 *     validateAndTransformBody(AdminCreateBrand),
 *     persistCustomFields(),
 *   ],
 * }
 *
 * It takes no arguments. The entity comes from the route's own `entity`
 * declaration, resolved once by the router, so there is nothing to restate and
 * nothing to drift.
 *
 * Values are validated on the way in and written on the way out. Validating
 * before the handler runs means a missing required field is rejected while the
 * request is still a no-op, rather than after the row exists — the same
 * ordering the workflow steps use. What it cannot offer is the workflow's
 * compensation: if the write fails after the entity was created, the entity
 * stays.
 *
 * **One record per request.** Custom fields are read from the top level of the
 * body and written against a single owner. A route whose *matcher* ends in a
 * route parameter is an update of that record (`/admin/brands/:id`,
 * `/admin/products/:id/variants/:variant_id`); anything else is a create, with
 * the id read from `payload[entity].id` in the response. A nested create like
 * `/admin/brands/:id/variants` is therefore a create of the declared entity —
 * the parent id in its path is never mistaken for the owner. Action-style
 * routes (`/admin/orders/:id/cancel`) end in a literal and classify as
 * creates; they belong on the workflow path, not on this middleware.
 *
 * **Writes one record, or several of the same shape.** A route that writes many
 * at once takes an array of exactly the object it would take for one, so each
 * element carries its own custom fields and they are handled one by one. That
 * is the only placement with any meaning for a bulk write: a value at the top
 * of the body could not say which record it belonged to.
 *
 * Core's `{ create: [...], update: [...], delete: [...] }` batch shape
 * (`api/utils/validators.ts:35`) is *not* this, and is not supported — a body
 * holding two different arrays has no single record list to pair values with.
 * Such a route should carry them through `validateCustomFieldsStep` and
 * `upsertCustomFieldsStep` in a workflow instead.
 */
export function persistCustomFields() {
  return function persistCustomFields(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) {
    const entity = req.customFieldsEntity
    const shape = req.customFieldsValidator

    // No entity declared, or no custom fields configured for it.
    if (!entity || !shape) {
      return next()
    }

    // Create or update is decided by the route's declared shape, not guessed
    // from the request. When the matcher's final segment is a route parameter
    // (`/admin/brands/:id`, `/admin/products/:id/variants/:variant_id`), the
    // router names it in `customFieldsOwnerParam`: the route operates on that
    // existing record, absent keys mean "leave alone", and the owner id is
    // that parameter's value. A matcher ending in a literal segment is a
    // create, whose ids do not exist until the handler has run and are read
    // from the response instead.
    //
    // Notably *not* `req.params.id`: on a nested create —
    // `/admin/brands/:id/variants` with `entity: "brand_variant"` — that holds
    // the *parent's* id, and writing the child's values against it would
    // corrupt the parent's row.
    const ownerParam = req.customFieldsOwnerParam
    const ownerId = ownerParam ? req.params?.[ownerParam] : undefined

    if (ownerParam && !ownerId) {
      return next(
        new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `Route parameter ":${ownerParam}" did not resolve for this request, ` +
            `so its "${entity}" custom field values cannot be written`
        )
      )
    }

    const partial = !!ownerId

    // One record or many, handled the same way from here on: a list of value
    // sets, positionally aligned with the records the request writes.
    const body = req.validatedBody
    const records: Record<string, unknown>[] = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : [(body ?? {}) as Record<string, unknown>]

    // An update targets exactly the one record the owner param names, so an
    // array body cannot be paired with it. Refusing beats writing the first
    // element's values and silently dropping the rest.
    if (partial && records.length > 1) {
      return next(
        new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `This route updates a single "${entity}" record, but the request ` +
            `body is an array of ${records.length}`
        )
      )
    }

    const values = records.map((record) => {
      const extracted: Record<string, unknown> = {}

      for (const key of Object.keys(shape)) {
        if (key in record) {
          extracted[key] = record[key]
          // Removed so the handler can hand the record to its module service
          // without it rejecting keys that belong to another module's table.
          delete record[key]
        }
      }

      return extracted
    })

    let service: any
    try {
      service = req.scope.resolve(Modules.CUSTOM_FIELDS)
      // Rejected here, before the handler creates anything. Runs for every
      // record, including one stating no custom fields at all — that is the
      // omitted-required case.
      values.forEach((value) =>
        service.validateValues(entity, value, { partial })
      )
    } catch (e) {
      return next(e)
    }

    // Validated but nothing to store, so no row is written and the response is
    // left alone. An owner that stated no custom field values keeps no
    // satellite row, which is what `upsertCustomFieldsStep` does on the
    // workflow path and what the nullable columns are designed around. Writing
    // an all-null row here instead would give every owner a row and settle the
    // open 1:1-semantics question by accident, differently from the other path.
    if (values.every((value) => !Object.keys(value).length)) {
      return next()
    }

    const respond = res.json.bind(res)

    res.json = function (payload: any) {
      // Restored before anything else. The error handler responds through
      // `res.json` too, so a handler failure — or a failure of the write
      // below — would otherwise re-enter this wrapper: on an update that
      // writes a satellite row for a record whose update just failed, on a
      // create it fails id pairing against the error payload and masks the
      // real error with a 500.
      res.json = respond

      // The handler failed; there is nothing to persist.
      if (res.statusCode >= 400) {
        return respond(payload)
      }

      const write = async () => {
        const owners = ownerId
          ? [ownerId]
          : resolveCreatedIds(payload, entity, values.length)

        for (const [index, owner] of owners.entries()) {
          if (!Object.keys(values[index] ?? {}).length) {
            continue
          }

          await service.setValues(entity, owner, values[index], { partial })
        }
      }

      // Nothing has been sent yet, so a failure is still reportable rather
      // than a silently dropped value behind a 200.
      write().then(
        () => respond(payload),
        (e) => next(e)
      )

      return res
    } as typeof res.json

    return next()
  }
}

/**
 * The ids of the records a create route just wrote, in the order it wrote them.
 *
 * Keyed on the declared entity rather than found structurally: responses
 * commonly carry several *different* records — `POST /admin/claims` returns
 * `{ order, claim }` — so taking the first thing holding an id would pick the
 * wrong one. The entity name disambiguates, and the route already declares it.
 *
 * `expected` is how many records the request wrote. A mismatch means the
 * response cannot be paired with the request positionally, and pairing values
 * with the wrong records is worse than refusing, so it throws.
 */
function resolveCreatedIds(
  payload: any,
  entity: string,
  expected: number
): string[] {
  const singular = payload?.[entity]
  const found = Array.isArray(payload)
    ? payload
    : Array.isArray(singular)
    ? singular
    : Array.isArray(payload?.[pluralize(entity)])
    ? payload[pluralize(entity)]
    : singular
    ? [singular]
    : []

  const ids = found.map((record: any) => record?.id).filter(Boolean)

  if (ids.length !== expected) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Could not pair custom fields with the "${entity}" record(s) this request wrote: ` +
        `it sent ${expected} but the response carries ${ids.length}. ` +
        `A route is expected to respond with { "${entity}": { id } }, or — when it writes ` +
        `several — the same records in the order they were sent. Routes whose request and ` +
        `response do not line up should use validateCustomFieldsStep and ` +
        `upsertCustomFieldsStep in a workflow instead.`
    )
  }

  return ids
}
