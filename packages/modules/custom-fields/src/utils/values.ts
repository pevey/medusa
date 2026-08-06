import { MedusaError } from "@medusajs/framework/utils"
import { CustomFieldDefinition, CustomFieldType } from "@/types"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether a string is a real calendar date in ISO `YYYY-MM-DD` form.
 * `2026-02-30` matches the regex but rolls over when parsed, so the parsed
 * date is checked against the input.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    return false
  }

  const parsed = new Date(`${value}T00:00:00Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

/**
 * Coerce a value into the form its column stores, rejecting anything that
 * cannot represent the definition's type, then enforce the definition's
 * `min`/`max` bounds.
 *
 * Used on every write by `validateValues`, and at boot by `resolveDefinitions`
 * to validate a `default_value` — a bad or out-of-bounds default fails startup
 * rather than the first write that relies on it.
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

  const coerced = (() => {
    switch (definition.type) {
      case CustomFieldType.text:
        return typeof value === "string" ? value : invalid("a string")

      case CustomFieldType.boolean:
        return typeof value === "boolean" ? value : invalid("a boolean")

      // `number` is an integer column, matching DML. Decimals belong to
      // `float`, and rounding one silently would lose data the caller sent.
      case CustomFieldType.number: {
        const numeric = toFinite()
        return Number.isInteger(numeric) ? numeric : invalid("an integer")
      }

      case CustomFieldType.float:
        return toFinite()

      // A calendar date, stored as the ISO string itself. A value carrying a
      // time component is rejected rather than truncated: truncation requires
      // choosing a timezone, which silently reintroduces the off-by-one-day
      // bug this type exists to prevent. The caller knows which timezone its
      // date means; this layer does not.
      case CustomFieldType.date:
        return isIsoDate(value)
          ? value
          : invalid("an ISO date (YYYY-MM-DD, no time component)")

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
  })()

  assertWithinBounds(entity, definition, coerced)

  return coerced
}

/**
 * Enforce `min`/`max` on a coerced value. Bounds are inclusive and exist only
 * on the types config validation allows them for — numbers compare
 * numerically, `dateTime` by timestamp, `date` lexicographically (correct for
 * ISO dates).
 */
function assertWithinBounds(
  entity: string,
  definition: CustomFieldDefinition,
  coerced: unknown
): void {
  const { min, max } = definition

  if (min === undefined && max === undefined) {
    return
  }

  const outOfBounds = (bound: "min" | "max", limit: number | string): never => {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `"${definition.key}" on "${entity}" must be ${
        bound === "min" ? "at least" : "at most"
      } ${limit}, received ${
        coerced instanceof Date ? coerced.toISOString() : coerced
      }`
    )
  }

  const comparable = (limit: number | string): number | string => {
    // dateTime bounds are configured as ISO strings but compared as time.
    return definition.type === CustomFieldType.dateTime
      ? new Date(limit as string).getTime()
      : limit
  }

  const actual = coerced instanceof Date ? coerced.getTime() : (coerced as any)

  if (min !== undefined && actual < comparable(min)) {
    outOfBounds("min", min)
  }

  if (max !== undefined && actual > comparable(max)) {
    outOfBounds("max", max)
  }
}
