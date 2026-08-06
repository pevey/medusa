import { z } from "@medusajs/deps/zod"
import { NextFunction } from "express"
import { MedusaRequest, MedusaResponse } from "../types"
import { zodValidator } from "../../zod"

/**
 * Merge the configured custom fields into a route's body schema, as a single
 * `custom_fields` object — the same shape reads return and filters use, so a
 * fetched record round-trips as a write body.
 *
 * Applied here rather than route by route: custom fields are declared per
 * entity, and the route states which entity it operates on through its
 * `entity` annotation. Nesting under one reserved key means a custom field
 * can never collide with a column the entity already has — the wrapper is the
 * only name the entity gives up.
 *
 * The wrapper and its keys are optional; `required` is enforced by the
 * pre-write workflow step, which knows whether it is running a create or an
 * update — a distinction the route (both are POST) cannot make.
 */
function withCustomFields(
  schema: z.ZodObject<any, any> | z.ZodType<any, any, any>,
  customFields?: z.ZodRawShape
): z.ZodObject<any, any> | z.ZodType<any, any, any> {
  if (!customFields || !Object.keys(customFields).length) {
    return schema
  }

  // Strict, so an unknown key inside `custom_fields` is a 400 naming it,
  // matching the strictness of the base body schema around it.
  const wrapper = { custom_fields: z.object(customFields).strict().nullish() }

  if (schema instanceof z.ZodObject) {
    return schema.extend(wrapper)
  }

  // A route that writes several records at once takes an array of the same
  // object it would take for one, so the wrapper extends each element rather
  // than the body. Each record then carries its own values.
  if (schema instanceof z.ZodArray && schema.element instanceof z.ZodObject) {
    return z.array(schema.element.extend(wrapper))
  }

  // Anything else (a union, an effect) is left alone rather than guessed at.
  return schema
}

export function validateAndTransformBody(
  zodSchema:
    | z.ZodObject<any, any>
    | z.ZodType<any, any, any>
    | ((
        customSchema?: z.ZodOptional<z.ZodNullable<z.ZodObject<any, any>>>
      ) => z.ZodObject<any, any> | z.ZodType<any, any, any>)
): (
  req: MedusaRequest,
  res: MedusaResponse,
  next: NextFunction
) => Promise<void> {
  return async function validateBody(
    req: MedusaRequest,
    _: MedusaResponse,
    next: NextFunction
  ) {
    try {
      let schema: z.ZodObject<any, any> | z.ZodType<any, any, any>
      if (typeof zodSchema === "function") {
        schema = zodSchema(req.additionalDataValidator)
      } else {
        schema = zodSchema
      }

      schema = withCustomFields(schema, req.customFieldsValidator)

      req.validatedBody = await zodValidator(schema, req.body)
      next()
    } catch (e) {
      next(e)
    }
  }
}
