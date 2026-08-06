import { z } from "@medusajs/framework/zod"
import {
  clearCustomFieldSchemas,
  setCustomFieldSchemas,
} from "@medusajs/framework/utils"
import { CustomFieldDefinition, CustomFieldType } from "@/types"

function baseSchema(definition: CustomFieldDefinition): any {
  switch (definition.type) {
    // Matches DML, where `number` is an integer column and `float` is the
    // one that takes decimals.
    case CustomFieldType.number:
      return withNumericBounds(z.number().int(), definition)
    case CustomFieldType.float:
      return withNumericBounds(z.number(), definition)
    case CustomFieldType.boolean:
      return z.boolean()
    case CustomFieldType.date: {
      let schema = z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}$/,
          `Expected an ISO date (YYYY-MM-DD, no time component)`
        )
      if (definition.min !== undefined) {
        schema = schema.refine((v: string) => v >= (definition.min as string), {
          message: `Must be on or after ${definition.min}`,
        }) as any
      }
      if (definition.max !== undefined) {
        schema = schema.refine((v: string) => v <= (definition.max as string), {
          message: `Must be on or before ${definition.max}`,
        }) as any
      }
      return schema
    }
    case CustomFieldType.dateTime: {
      let schema = z.coerce.date()
      if (definition.min !== undefined) {
        schema = schema.min(new Date(definition.min as string))
      }
      if (definition.max !== undefined) {
        schema = schema.max(new Date(definition.max as string))
      }
      return schema
    }
    case CustomFieldType.json:
      return z.any()
    case CustomFieldType.enum:
      return z.enum(definition.choices as [string, ...string[]])
    case CustomFieldType.text:
    default:
      return z.string()
  }
}

function withNumericBounds(schema: any, definition: CustomFieldDefinition) {
  if (definition.min !== undefined) {
    schema = schema.min(definition.min as number)
  }
  if (definition.max !== undefined) {
    schema = schema.max(definition.max as number)
  }
  return schema
}

/**
 * A filter value: the scalar itself, a list of them, or an operator object.
 *
 * Deliberately permissive rather than an enumeration of every operator — the
 * query layer already rejects operators it cannot compile, and duplicating that
 * list here would mean maintaining it in two places.
 */
function filterSchema(definition: CustomFieldDefinition): any {
  const schema = baseSchema(definition)

  return z
    .union([schema, z.array(schema), z.record(z.string(), z.any())])
    .optional()
}

/**
 * Publish zod shapes for the HTTP layer to merge into request validation.
 *
 * Two variants per entity. The `write` shape is what a body's `custom_fields`
 * object may contain — every key optional and nullable, because create and
 * update share one route surface and `required` is enforced by the pre-write
 * workflow step, which knows which operation it is running. The `filter`
 * variant is what reads are narrowed by.
 *
 * Readonly fields are omitted from the `write` shape entirely: the merged
 * object is strict, so a readonly key in a payload rejects as an unrecognized
 * field. This is deliberately the HTTP boundary and not the module service —
 * `readonly` is about who is writing, and only HTTP knows the caller is
 * external; workflow and service calls (the intended writers of readonly
 * values) are unaffected. The `filter` variant keeps every field: readonly
 * fields stay readable and filterable.
 */
export function publishCustomFieldSchemas(
  definitionsByEntity: Map<string, CustomFieldDefinition[]>
): void {
  clearCustomFieldSchemas()

  for (const [entity, definitions] of definitionsByEntity) {
    const write: Record<string, any> = {}
    const filter: Record<string, any> = {}
    const storeFilter: Record<string, any> = {}
    const publicKeys: string[] = []

    for (const definition of definitions) {
      if (!definition.readonly) {
        write[definition.key] = baseSchema(definition).nullish()
      }

      filter[definition.key] = filterSchema(definition)

      if (!definition.restricted) {
        storeFilter[definition.key] = filterSchema(definition)
        publicKeys.push(definition.key)
      }
    }

    setCustomFieldSchemas(entity, { write, filter, storeFilter, publicKeys })
  }
}
