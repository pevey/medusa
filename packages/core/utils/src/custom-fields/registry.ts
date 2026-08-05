/**
 * Zod shapes for configured custom fields, keyed by entity.
 *
 * The custom fields module owns the definitions, but the HTTP layer needs the
 * shapes to merge them into request validation — and the framework cannot
 * depend on a module. A global registry keeps the dependency pointing the right
 * way: the module publishes, the framework reads. Same arrangement as
 * `global.PolicyOperation`.
 */
export type CustomFieldSchemas = {
  /**
   * Every field, with `required` ones non-optional. Used for create.
   */
  create: Record<string, any>
  /**
   * Every field optional, so an update can touch a subset.
   */
  update: Record<string, any>
  /**
   * Every field optional and permissive, for filtering on reads. Nested under
   * `custom_fields` rather than merged as top-level keys, because that is the
   * shape `query.graph` filters on and the shape reads come back in — a
   * top-level `brand` would also collide with the entity's own columns.
   */
  filter: Record<string, any>
}

const REGISTRY: Map<string, CustomFieldSchemas> =
  (global as any).__MEDUSA_CUSTOM_FIELD_SCHEMAS__ ?? new Map()

;(global as any).__MEDUSA_CUSTOM_FIELD_SCHEMAS__ = REGISTRY

export function setCustomFieldSchemas(
  entity: string,
  schemas: CustomFieldSchemas
): void {
  REGISTRY.set(entity, schemas)
}

export function clearCustomFieldSchemas(): void {
  REGISTRY.clear()
}

export function hasCustomFieldSchemas(): boolean {
  return REGISTRY.size > 0
}

export type CustomFieldSchemaVariant = keyof CustomFieldSchemas

/**
 * The shape to merge into a route's schema.
 *
 * The variant is chosen by the caller from the request method and the route's
 * declared policies — see `ApiLoader`.
 */
export function getCustomFieldSchema(
  entity: string,
  variant: CustomFieldSchemaVariant
): Record<string, any> | undefined {
  return REGISTRY.get(entity)?.[variant]
}
