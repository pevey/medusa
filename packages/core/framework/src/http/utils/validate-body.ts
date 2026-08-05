import { z } from "@medusajs/deps/zod"
import { NextFunction } from "express"
import { MedusaRequest, MedusaResponse } from "../types"
import { zodValidator } from "../../zod"

/**
 * Merge configured custom fields into a route's body schema.
 *
 * Applied here rather than route by route: custom fields are declared per
 * entity, and every create/update route already states which entity it operates
 * on through its `policies`. Threading the shape through this one place means
 * no route has to opt in, and a field declared `required` is a plain
 * non-optional key on the body — not something nested under an optional object
 * that a caller can bypass by omitting it.
 */
function withCustomFields(
  schema: z.ZodObject<any, any> | z.ZodType<any, any, any>,
  customFields?: z.ZodRawShape
): z.ZodObject<any, any> | z.ZodType<any, any, any> {
  if (!customFields || !Object.keys(customFields).length) {
    return schema
  }

  if (schema instanceof z.ZodObject) {
    return schema.extend(customFields)
  }

  // A route that writes several records at once takes an array of the same
  // object it would take for one, so the fields extend each element rather than
  // the body. Each record then carries its own values, which is the only
  // placement that means anything for a bulk write.
  if (schema instanceof z.ZodArray && schema.element instanceof z.ZodObject) {
    return z.array(schema.element.extend(customFields))
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
