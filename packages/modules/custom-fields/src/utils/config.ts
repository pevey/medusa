import { MedusaError } from "@medusajs/framework/utils"
import {
  CustomFieldConfig,
  CustomFieldDefinition,
  CustomFieldsModuleOptions,
  CustomFieldType,
} from "@/types"
import { RESERVED_KEYS, assertSafeIdentifier } from "./satellite"

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
      // between boots regardless of key order in the config object.
      .sort((a, b) => a.key.localeCompare(b.key))

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

  return {
    entity,
    key,
    type: config.type,
    choices: config.choices,
    required: config.required ?? false,
    indexed: config.indexed ?? false,
    default_value: config.default_value,
    label: config.label,
    description: config.description,
  }
}
