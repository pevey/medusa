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
      return z.number().int()
    case CustomFieldType.float:
      return z.number()
    case CustomFieldType.boolean:
      return z.boolean()
    case CustomFieldType.dateTime:
      return z.coerce.date()
    case CustomFieldType.json:
      return z.any()
    case CustomFieldType.enum:
      return z.enum(definition.choices as [string, ...string[]])
    case CustomFieldType.text:
    default:
      return z.string()
  }
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
 * Three variants per entity. On create, a `required` field is a plain
 * non-optional key — there is no wrapper object a caller can omit to skip
 * validation, which is the hole the `additional_data` path leaves open. On
 * update every key is optional so a caller can touch a subset; the required
 * constraint is still enforced when a value is explicitly cleared, by the
 * module service. The filter variant is what reads are narrowed by.
 */
export function publishCustomFieldSchemas(
  definitionsByEntity: Map<string, CustomFieldDefinition[]>
): void {
  clearCustomFieldSchemas()

  for (const [entity, definitions] of definitionsByEntity) {
    const create: Record<string, any> = {}
    const update: Record<string, any> = {}
    const filter: Record<string, any> = {}

    for (const definition of definitions) {
      const schema = baseSchema(definition)

      create[definition.key] = definition.required
        ? schema
        : schema.nullish()

      update[definition.key] = schema.nullish()
      filter[definition.key] = filterSchema(definition)
    }

    setCustomFieldSchemas(entity, { create, update, filter })
  }
}
