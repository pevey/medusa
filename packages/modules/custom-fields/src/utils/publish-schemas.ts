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
 * Two variants per entity. The `write` shape is what a body's `custom_fields`
 * object may contain — every key optional and nullable, because create and
 * update share one route surface and `required` is enforced by the pre-write
 * workflow step, which knows which operation it is running. The `filter`
 * variant is what reads are narrowed by.
 */
export function publishCustomFieldSchemas(
  definitionsByEntity: Map<string, CustomFieldDefinition[]>
): void {
  clearCustomFieldSchemas()

  for (const [entity, definitions] of definitionsByEntity) {
    const write: Record<string, any> = {}
    const filter: Record<string, any> = {}

    for (const definition of definitions) {
      write[definition.key] = baseSchema(definition).nullish()
      filter[definition.key] = filterSchema(definition)
    }

    setCustomFieldSchemas(entity, { write, filter })
  }
}
