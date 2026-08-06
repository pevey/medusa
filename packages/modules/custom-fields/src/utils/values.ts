import { MedusaError } from "@medusajs/framework/utils"
import { CustomFieldDefinition, CustomFieldType } from "@/types"

/**
 * Coerce a value into the form its column stores, rejecting anything that
 * cannot represent the definition's type.
 *
 * Used on every write by `validateValues`, and at boot by `resolveDefinitions`
 * to validate a `default_value` — a bad default fails startup rather than the
 * first write that relies on it.
 */
export function coerceValue(
  entity: string,
  definition: CustomFieldDefinition,
  value: unknown
): unknown {
  const invalid = (expected: string): never => {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `"${definition.key}" on "${entity}" expects ${expected}, received ${typeof value}`
    )
  }

  const toFinite = (): number => {
    const numeric = typeof value === "string" ? Number(value) : value
    return typeof numeric === "number" && Number.isFinite(numeric)
      ? numeric
      : (invalid("a number") as never)
  }

  switch (definition.type) {
    case CustomFieldType.text:
      return typeof value === "string" ? value : invalid("a string")

    case CustomFieldType.boolean:
      return typeof value === "boolean" ? value : invalid("a boolean")

    // `number` is an integer column, matching DML. Decimals belong to `float`,
    // and rounding one silently would lose data the caller sent.
    case CustomFieldType.number: {
      const numeric = toFinite()
      return Number.isInteger(numeric) ? numeric : invalid("an integer")
    }

    case CustomFieldType.float:
      return toFinite()

    case CustomFieldType.dateTime: {
      const date = value instanceof Date ? value : new Date(value as string)
      return Number.isNaN(date.getTime()) ? invalid("a date") : date
    }

    case CustomFieldType.enum:
      return definition.choices?.includes(value as string)
        ? value
        : invalid(`one of: ${definition.choices?.join(", ")}`)

    // Serialized here rather than left to the driver, which would otherwise
    // stringify an object as "[object Object]" into a jsonb column.
    case CustomFieldType.json:
      return JSON.stringify(value)

    default:
      return invalid("a supported type")
  }
}
