import { MedusaError, isDefined } from "@medusajs/framework/utils"
import {
  CustomFieldConfig,
  CustomFieldDefinition,
  CustomFieldsModuleOptions,
  CustomFieldType,
} from "@/types"
import { RESERVED_KEYS, assertSafeIdentifier } from "./satellite"
import { coerceValue, isIsoDate } from "./values"

/**
 * Turn module options into resolved definitions, applying defaults and
 * rejecting anything that could not safely become a column.
 *
 * Keys become column names and entity names become table names, so both are
 * constrained to plain identifiers. This runs at boot, so a bad config fails
 * loudly at startup rather than at the first request that touches the field.
 */
export function resolveDefinitions(
  options: CustomFieldsModuleOptions | undefined
): Map<string, CustomFieldDefinition[]> {
  const byEntity = new Map<string, CustomFieldDefinition[]>()

  for (const [entity, fields] of Object.entries(options?.fields ?? {})) {
    assertSafeIdentifier(entity, "entity name")

    const definitions = Object.entries(fields ?? {})
      .map(([key, config]) => resolveDefinition(entity, key, config))
      // Sorted so generated DDL, admin forms, and joiner configs are stable
      // between boots regardless of key order in the config object — which is
      // deliberately not an ordering signal, since a machine-edited config
      // cannot be trusted to preserve it. `rank` (ascending, default 0, the
      // admin UI route convention) is the ordering tool; key breaks ties.
      .sort(
        (a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.key.localeCompare(b.key)
      )

    if (definitions.length) {
      byEntity.set(entity, definitions)
    }
  }

  return byEntity
}

function resolveDefinition(
  entity: string,
  key: string,
  config: CustomFieldConfig
): CustomFieldDefinition {
  assertSafeIdentifier(key, "custom field key")

  if (RESERVED_KEYS.has(key)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Custom field "${entity}.${key}" uses a reserved key`
    )
  }

  if (!config?.type || !(config.type in CustomFieldType)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Custom field "${entity}.${key}" has an unknown type "${
        config?.type
      }". Expected one of: ${Object.keys(CustomFieldType).join(", ")}`
    )
  }

  const isEnum = config.type === CustomFieldType.enum

  if (isEnum && !config.choices?.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Custom field "${entity}.${key}" is an enum and must declare "choices"`
    )
  }

  if (!isEnum && config.choices?.length) {
    // Silently ignoring it would leave a config that reads as constrained but
    // accepts anything.
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Custom field "${entity}.${key}" declares "choices" but is not an enum`
    )
  }

  validateBoundsConfig(entity, key, config)

  // An HTTP create could never satisfy this combination: readonly keys are
  // rejected at admission, so the required value could only come from the
  // default. Failing the boot beats failing every create.
  if (config.required && config.readonly && !isDefined(config.default_value)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Custom field "${entity}.${key}" is required and readonly but has no default_value`
    )
  }

  if (isDefined(config.rank) && !Number.isFinite(config.rank)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Custom field "${entity}.${key}" has a non-numeric rank`
    )
  }

  const definition: CustomFieldDefinition = {
    entity,
    key,
    type: config.type,
    choices: config.choices,
    required: config.required ?? false,
    indexed: config.indexed ?? false,
    readonly: config.readonly ?? false,
    restricted: config.restricted ?? false,
    min: config.min,
    max: config.max,
    rank: config.rank,
    default_value: config.default_value,
    label: config.label,
    description: config.description,
  }

  // Validated the way a written value would be, so a type-invalid default —
  // `{ type: "number", default_value: "abc" }`, an enum default outside its
  // choices, a default outside the min/max bounds — fails the boot rather
  // than the first write that relies on it. The raw configured value is what
  // gets stored: it is coerced again at each point of use, exactly like a
  // written value.
  if (isDefined(definition.default_value)) {
    try {
      coerceValue(entity, definition, definition.default_value)
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Custom field "${entity}.${key}" has an invalid default_value: ${
          (error as Error).message
        }`
      )
    }
  }

  return definition
}

const BOUNDED_TYPES = new Set<string>([
  CustomFieldType.number,
  CustomFieldType.float,
  CustomFieldType.date,
  CustomFieldType.dateTime,
])

/**
 * `min`/`max` are valid on numeric and date types only, and must themselves be
 * well-formed for the field's type — numbers for `number`/`float` (integers
 * for `number`), ISO strings for `date`/`dateTime`. As with a stray `choices`,
 * a bound on an unbounded type is rejected rather than ignored: silently
 * ignoring it would leave a config that reads as constrained but accepts
 * anything.
 */
function validateBoundsConfig(
  entity: string,
  key: string,
  config: CustomFieldConfig
): void {
  const bounds = (["min", "max"] as const).filter((b) => isDefined(config[b]))

  if (!bounds.length) {
    return
  }

  const fail = (reason: string): never => {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Custom field "${entity}.${key}" ${reason}`
    )
  }

  if (!BOUNDED_TYPES.has(config.type)) {
    fail(`declares min/max but its type "${config.type}" is not bounded`)
  }

  for (const bound of bounds) {
    const limit = config[bound]!

    switch (config.type) {
      case CustomFieldType.number:
        if (typeof limit !== "number" || !Number.isInteger(limit)) {
          fail(`has a ${bound} that is not an integer`)
        }
        break
      case CustomFieldType.float:
        if (typeof limit !== "number" || !Number.isFinite(limit)) {
          fail(`has a ${bound} that is not a number`)
        }
        break
      case CustomFieldType.date:
        if (!isIsoDate(limit)) {
          fail(`has a ${bound} that is not an ISO date (YYYY-MM-DD)`)
        }
        break
      case CustomFieldType.dateTime:
        if (
          typeof limit !== "string" ||
          Number.isNaN(new Date(limit).getTime())
        ) {
          fail(`has a ${bound} that is not a valid ISO date-time`)
        }
        break
    }
  }

  if (isDefined(config.min) && isDefined(config.max)) {
    const [minComparable, maxComparable] =
      config.type === CustomFieldType.dateTime
        ? [
            new Date(config.min as string).getTime(),
            new Date(config.max as string).getTime(),
          ]
        : [config.min!, config.max!]

    if (minComparable > maxComparable) {
      fail(`has min greater than max`)
    }
  }
}
