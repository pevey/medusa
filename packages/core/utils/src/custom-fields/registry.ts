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
   * The shape of the `custom_fields` object a write may carry, with every
   * field optional: create and update share one route surface (both POST), so
   * the route only admits the keys — `required` is enforced by the pre-write
   * workflow step, which knows which operation it is running.
   */
  write: Record<string, any>
  /**
   * Every field optional and permissive, for filtering on reads. Nested under
   * `custom_fields`, because that is the shape `query.graph` filters on and
   * the shape reads come back in.
   */
  filter: Record<string, any>
  /**
   * The `filter` shape minus `restricted` fields — what store-scoped reads
   * may be narrowed by. Filtering by a restricted key then fails exactly like
   * filtering by a key that does not exist, which discloses nothing.
   */
  storeFilter: Record<string, any>
  /**
   * The keys retrievable through the store API (i.e. not `restricted`), in
   * display order. The router rewrites store-scoped `custom_fields` selectors
   * against this list.
   */
  publicKeys: string[]
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

/**
 * Every entity with published shapes — i.e. every entity custom fields are
 * configured for. The router reconciles this against the routes that declare
 * an `entity`, to warn about fields that could never be sent.
 */
export function listCustomFieldSchemaEntities(): string[] {
  return [...REGISTRY.keys()]
}

export type CustomFieldSchemaVariant = "write" | "filter" | "storeFilter"

/**
 * The shape to merge into a route's schema, chosen by the router from the
 * request method and scope: writes get `write`, everything that reaches a
 * query validator gets `filter` — or `storeFilter` on store routes.
 */
export function getCustomFieldSchema(
  entity: string,
  variant: CustomFieldSchemaVariant
): Record<string, any> | undefined {
  return REGISTRY.get(entity)?.[variant]
}

/**
 * The keys retrievable through the store API for an entity, in display order.
 * `undefined` when the entity has no custom fields at all.
 */
export function getCustomFieldPublicKeys(entity: string): string[] | undefined {
  return REGISTRY.get(entity)?.publicKeys
}
